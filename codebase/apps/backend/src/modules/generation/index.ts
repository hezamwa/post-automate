// Bounded context: generation (AR-10.2) — angles, article, derivatives.
// All AI calls go through the router (AR-10.9); guardrails live in the prompts.
import { and, desc, eq } from "drizzle-orm";
import type { Language, Profile } from "@post-automate/shared";
import { GateError } from "../../ai/gates";
import { NoRouteError, runImageTask, runTask } from "../../ai/router";
import { schema } from "../../db/client";
import { articleSystem } from "../../ai/prompts/blocks";
import {
  anglesPrompt,
  anglesSchema,
  articleSchema,
  articleUser,
  imagePrompt,
  shortenLinkedInPrompt,
  shortenXPrompt,
  translatePrompt,
  translateSchema,
  type Angle,
  type TopicBrief,
  type TranslatedArticle,
} from "../../ai/prompts/tasks";
import type { Db } from "../../db/client";
import type { Env } from "../../shared/env";

export interface Article {
  title: string;
  slug: string;
  excerpt: string;
  tags: string[];
  imageAlt: string;
  markdown: string;
}

export interface DerivedTexts {
  xVersion?: string;
  linkedinVersion?: string;
  translatedMarkdown?: string;
}

/** One per-kind outcome row for DR-9.14 — recorded to draft_derivatives by the caller. */
export interface TextDerivativeOutcome {
  kind: "x" | "linkedin" | "translation";
  outcome: "produced" | "skipped" | "failed";
  content?: string;
  reason?: string; // why skipped/failed — human-readable, surfaced on the review screen
  /** Translation only: what the publish-time second document needs (design §8). */
  meta?: { title: string; excerpt: string; imageAlt: string; targetLanguage: Language };
}

export interface DeriveTextsResult {
  texts: DerivedTexts;
  outcomes: TextDerivativeOutcome[];
}

export class ComplianceRefusalError extends Error {
  constructor() {
    super("The model determined the topic cannot be covered within the compliance guardrails (CANNOT_COMPLY, FR-6.6-6.8)");
    this.name = "ComplianceRefusalError";
  }
}

interface RunCtx {
  userId: string;
  runId: string;
  profile: Profile;
}

/** FR-6.3 step 1: three angles + a recommended pick in one structured call. */
export async function proposeAngles(
  env: Env,
  db: Db,
  ctx: RunCtx,
  topic: TopicBrief,
): Promise<{ angles: Angle[]; recommendedIndex: number }> {
  const prompt = anglesPrompt(ctx.profile, topic);
  const result = await runTask(env, db, {
    taskType: "angles",
    userId: ctx.userId,
    runId: ctx.runId,
    input: {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      jsonSchema: anglesSchema as unknown as Record<string, unknown>,
      maxTokens: 4000,
    },
  });
  const parsed = result.parsed as { angles: Angle[]; recommendedIndex: number };
  const idx = Math.min(Math.max(parsed.recommendedIndex, 0), parsed.angles.length - 1);
  return { angles: parsed.angles, recommendedIndex: idx };
}

export interface ArticleResult {
  article: Article;
  provider: string; // → generationMeta (FR-8.2)
  model: string;
}

/** FR-6.3 step 2: the article, plus slug/excerpt/tags/imageAlt in one structured call (FR-8.2 mapper inputs). */
export async function writeArticle(
  env: Env,
  db: Db,
  ctx: RunCtx,
  topic: TopicBrief,
  angle: Angle,
  revision?: { currentMarkdown: string; instructions: string },
): Promise<ArticleResult> {
  const system = articleSystem(ctx.profile, /* approvedExamples: from Sanity later (FR-6.2) */ []);
  const user = revision
    ? `Here is the current draft:\n\n${revision.currentMarkdown}\n\nRevise it according to these instructions from the creator, keeping every editorial and compliance rule intact:\n"${revision.instructions}"\n\nReturn the full revised article with updated slug/excerpt/tags/imageAlt.`
    : articleUser(topic, angle);
  const result = await runTask(env, db, {
    taskType: "article",
    userId: ctx.userId,
    runId: ctx.runId,
    input: {
      system,
      messages: [{ role: "user", content: user }],
      jsonSchema: articleSchema as unknown as Record<string, unknown>,
      maxTokens: 16000,
    },
  });
  const article = result.parsed as Article;
  if (article.markdown.trim().startsWith("CANNOT_COMPLY")) throw new ComplianceRefusalError();
  return { article, provider: result.provider, model: result.model };
}

function failureReason(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : "unknown error";
}

/**
 * FR-6.12/6.14 text derivatives — channel versions per profile.channels; translation only
 * when the profile opts in (FR-3.13). Skip-not-fail (FR-15.13, design §5): a missing or
 * unroutable derivative must not throw away a good article —
 *  · optional derivative, capability disabled (no enabled route) → `skipped`, continue;
 *  · optional derivative attempted but the call failed            → `failed`,  continue;
 *  · translation REQUESTED but unroutable or failing              → `failed` with the
 *    reason surfaced — a requested deliverable may not be silently dropped;
 *  · translation not requested → no outcome row at all (absent, not skipped).
 * Only the article task type may fail the run — that happens upstream in writeArticle.
 */
export async function deriveTexts(env: Env, db: Db, ctx: RunCtx, article: Article): Promise<DeriveTextsResult> {
  const channels = ctx.profile.channels ?? ["x", "linkedin"];
  const texts: DerivedTexts = {};
  const outcomes: TextDerivativeOutcome[] = [];

  const channelTasks = [
    { kind: "x" as const, taskType: "shorten_x" as const, prompt: shortenXPrompt(ctx.profile), maxChars: 280 },
    { kind: "linkedin" as const, taskType: "shorten_linkedin" as const, prompt: shortenLinkedInPrompt(ctx.profile), maxChars: 3000 },
  ];
  for (const t of channelTasks) {
    if (!channels.includes(t.kind)) continue; // not asked for → absent, no row (design §5)
    try {
      const content = await boundedShorten(env, db, ctx, t.taskType, t.prompt, article.markdown, t.maxChars);
      if (t.kind === "x") texts.xVersion = content;
      else texts.linkedinVersion = content;
      outcomes.push({ kind: t.kind, outcome: "produced", content });
    } catch (e) {
      // Gates (ai.paused, caps, suspension) are NOT derivative failures — they must halt
      // the step (FR-15.12a "halting in-flight runs"); skip-not-fail covers routes and
      // provider errors only (FR-15.13).
      if (e instanceof GateError) throw e;
      if (e instanceof NoRouteError) {
        outcomes.push({
          kind: t.kind,
          outcome: "skipped",
          reason: `The '${t.taskType}' capability is disabled — no enabled route (FR-15.13). Re-enable a route and revise the draft to generate it.`,
        });
      } else {
        outcomes.push({ kind: t.kind, outcome: "failed", reason: failureReason(e) });
      }
    }
  }

  // targetLanguage is guaranteed by profileSchema when enabled (FR-3.13)
  if (ctx.profile.translation.enabled && ctx.profile.translation.targetLanguage) {
    const result = await runTranslation(env, db, ctx, {
      title: article.title,
      excerpt: article.excerpt,
      imageAlt: article.imageAlt,
      markdown: article.markdown,
    }, ctx.profile.translation.targetLanguage);
    if (result.outcome === "produced") texts.translatedMarkdown = result.content;
    outcomes.push(result);
  }
  return { texts, outcomes };
}

/** One translate call → a DR-9.14 outcome record. Requested-but-undeliverable is `failed`, never silent (FR-15.13). */
async function runTranslation(
  env: Env,
  db: Db,
  ctx: { userId: string; runId: string | null },
  source: { title?: string; excerpt?: string; imageAlt?: string; markdown: string },
  targetLanguage: Language,
): Promise<TextDerivativeOutcome> {
  try {
    const prompt = translatePrompt(targetLanguage);
    const result = await runTask(env, db, {
      taskType: "translate",
      userId: ctx.userId,
      runId: ctx.runId,
      input: {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user(source) }],
        jsonSchema: translateSchema as unknown as Record<string, unknown>,
        maxTokens: 16000,
      },
    });
    const parsed = result.parsed as TranslatedArticle;
    return {
      kind: "translation",
      outcome: "produced",
      content: parsed.markdown.trim(), // the review screen renders content (DR-9.14)
      meta: { title: parsed.title, excerpt: parsed.excerpt, imageAlt: parsed.imageAlt, targetLanguage },
    };
  } catch (e) {
    if (e instanceof GateError) throw e; // pauses/caps halt — never recorded as a mere failed derivative
    const reason =
      e instanceof NoRouteError
        ? "A translation was requested but no enabled route can serve the 'translate' task (FR-15.13). Enable a route and request the translation again."
        : failureReason(e);
    return { kind: "translation", outcome: "failed", reason };
  }
}

/**
 * Latest derivative revision for a draft (DR-9.14, FR-7.9). Read from draft_derivatives —
 * not draft_revisions — because change_angle revisions re-derive without an instructions
 * row, and the override must land on the same revision the review screen shows.
 */
async function currentRevisionNo(db: Db, draftId: string): Promise<number> {
  const [latest] = await db
    .select({ revisionNo: schema.draftDerivatives.revisionNo })
    .from(schema.draftDerivatives)
    .where(eq(schema.draftDerivatives.draftId, draftId))
    .orderBy(desc(schema.draftDerivatives.revisionNo))
    .limit(1);
  return latest?.revisionNo ?? 0;
}

/**
 * FR-6.14 per-draft translation override (POST /drafts/:id/derivatives/translation):
 * runs standalone against the `translate` route — it does NOT re-enter the Workflow,
 * since the article is final and only the derivative changes. Metered to the draft's
 * owner and run; every gate applies. The outcome — produced or failed — is recorded to
 * draft_derivatives at the draft's current revision and returned for the review screen.
 */
export async function translateDraft(
  env: Env,
  db: Db,
  args: {
    draftId: string;
    runId: string | null;
    userId: string;
    markdown: string;
    title?: string;
    targetLanguage: Language;
  },
): Promise<TextDerivativeOutcome & { revisionNo: number }> {
  const result = await runTranslation(
    env,
    db,
    { userId: args.userId, runId: args.runId },
    { title: args.title, markdown: args.markdown },
    args.targetLanguage,
  );
  const revisionNo = await currentRevisionNo(db, args.draftId);
  await db
    .insert(schema.draftDerivatives)
    .values({
      draftId: args.draftId,
      kind: "translation",
      outcome: result.outcome,
      content: result.content ?? null,
      reason: result.reason ?? null,
      meta: result.meta ?? null,
      revisionNo,
    })
    .onConflictDoUpdate({
      target: [schema.draftDerivatives.draftId, schema.draftDerivatives.kind, schema.draftDerivatives.revisionNo],
      set: {
        outcome: result.outcome,
        content: result.content ?? null,
        reason: result.reason ?? null,
        meta: result.meta ?? null,
        createdAt: new Date(),
      },
    });
  return { ...result, revisionNo };
}

/** FR-6.14 the other direction: drop the translation the profile produced for this draft. */
export async function dropDraftTranslation(db: Db, draftId: string): Promise<boolean> {
  const revisionNo = await currentRevisionNo(db, draftId);
  const deleted = await db
    .delete(schema.draftDerivatives)
    .where(
      and(
        eq(schema.draftDerivatives.draftId, draftId),
        eq(schema.draftDerivatives.kind, "translation"),
        eq(schema.draftDerivatives.revisionNo, revisionNo),
      ),
    )
    .returning({ id: schema.draftDerivatives.id });
  return deleted.length > 0;
}

/** One retry with corrective feedback if the channel limit is exceeded; the reviewer is the final net. */
async function boundedShorten(
  env: Env,
  db: Db,
  ctx: RunCtx,
  taskType: "shorten_x" | "shorten_linkedin",
  system: string,
  markdown: string,
  maxChars: number,
): Promise<string> {
  const first = await runTask(env, db, {
    taskType,
    userId: ctx.userId,
    runId: ctx.runId,
    input: { system, messages: [{ role: "user", content: markdown }], maxTokens: 8000 },
  });
  let text = first.text.trim();
  if (text.length > maxChars) {
    const retry = await runTask(env, db, {
      taskType,
      userId: ctx.userId,
      runId: ctx.runId,
      input: {
        system,
        messages: [
          { role: "user", content: markdown },
          { role: "assistant", content: text },
          { role: "user", content: `That is ${text.length} characters — the hard limit is ${maxChars}. Rewrite it shorter.` },
        ],
        maxTokens: 8000,
      },
    });
    if (retry.text.trim().length < text.length) text = retry.text.trim();
  }
  return text;
}

/** FR-6.13: hero image. Returned as base64 — the publishing step uploads it to Sanity
 * immediately (image bytes must never be a Workflow step return value: too large). */
export async function generateHeroImage(
  env: Env,
  db: Db,
  ctx: RunCtx,
  article: Article,
): Promise<{ imageBase64: string; mimeType: string; alt: string }> {
  const result = await runImageTask(env, db, {
    taskType: "image",
    userId: ctx.userId,
    runId: ctx.runId,
    prompt: imagePrompt(article.title, ctx.profile),
    size: "1536x1024",
  });
  return { imageBase64: result.imageBase64, mimeType: result.mimeType, alt: article.imageAlt };
}
