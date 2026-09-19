// Bounded context: generation (AR-10.2) — angles, article, derivatives.
// All AI calls go through the router (AR-10.9); prompts live in workflows/prompts and
// guardrails live inside them.
import { and, desc, eq } from "drizzle-orm";
import type { Language, Profile } from "@post-automate/shared";
import { GateError } from "../../ai/gates";
import { toChatRequest, type PromptSpec } from "../../ai/prompts/spec";
import { NoRouteError, runImageTask, runTask } from "../../ai/router";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { buildAnglesPrompt } from "../../workflows/prompts/angles";
import { buildDeriveLinkedInPrompt, LINKEDIN_MAX_CHARS } from "../../workflows/prompts/derive-linkedin";
import { buildDeriveXPrompt, X_MAX_CHARS } from "../../workflows/prompts/derive-x";
import { buildDraftPrompt } from "../../workflows/prompts/draft";
import { buildHeroImagePrompt } from "../../workflows/prompts/hero-image";
import { buildOutlinePrompt } from "../../workflows/prompts/outline";
import { buildQualityCheckPrompt } from "../../workflows/prompts/quality-check";
import { buildTranslatePrompt } from "../../workflows/prompts/translate";
import { deterministicChecks, mergeQuality } from "./quality";
import type { TopicBrief } from "../discovery/types";
import type { Angle, AngleProposals, Article, ArticleResult, Outline, QualityCheck, TextDerivativeOutcome } from "./types";

export type { Angle, AngleProposals, Article, ArticleResult, DerivedTexts, TextDerivativeOutcome } from "./types";

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
export async function proposeAngles(env: Env, db: Db, ctx: RunCtx, topic: TopicBrief): Promise<AngleProposals> {
  const result = await runTask(env, db, {
    taskType: "angles",
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(buildAnglesPrompt({ profile: ctx.profile, topic })),
  });
  const parsed = result.parsed as AngleProposals;
  const idx = Math.min(Math.max(parsed.recommendedIndex, 0), parsed.angles.length - 1);
  return { angles: parsed.angles, recommendedIndex: idx };
}

/** FR-6.3 step 2: the article, plus slug/excerpt/tags/imageAlt in one structured call (FR-8.2 mapper inputs). */
export interface Grounding {
  outline?: Outline | null;
  sources?: Array<{ url: string; excerpt: string }>;
}

export async function writeArticle(
  env: Env,
  db: Db,
  ctx: RunCtx,
  topic: TopicBrief,
  angle: Angle,
  revision?: { currentMarkdown: string; instructions: string },
  grounding: Grounding = {},
): Promise<ArticleResult> {
  const result = await runTask(env, db, {
    taskType: "article",
    userId: ctx.userId,
    runId: ctx.runId,
    // approvedExamples: from Sanity later (FR-6.2)
    input: toChatRequest(buildDraftPrompt({ profile: ctx.profile, topic, angle, approvedExamples: [], revision, ...grounding })),
  });
  const article = result.parsed as Article;
  if (article.markdown.trim().startsWith("CANNOT_COMPLY")) throw new ComplianceRefusalError();
  return { article, provider: result.provider, model: result.model };
}

function failureReason(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : "unknown error";
}

export type ChannelKind = "x" | "linkedin";

export const CHANNELS = {
  x: { taskType: "shorten_x", build: buildDeriveXPrompt, maxChars: X_MAX_CHARS },
  linkedin: { taskType: "shorten_linkedin", build: buildDeriveLinkedInPrompt, maxChars: LINKEDIN_MAX_CHARS },
} as const;

/**
 * FR-6.12: ONE channel-version call (X or LinkedIn) from the final markdown. Pass the
 * previous over-limit answer as `tooLong` for the corrective second pass — that pass is
 * its own step, so a failed rewrite never re-bills the first call (spec §3).
 */
export async function deriveChannelText(
  env: Env,
  db: Db,
  ctx: RunCtx,
  kind: ChannelKind,
  markdown: string,
  tooLong?: string,
): Promise<string> {
  const channel = CHANNELS[kind];
  const result = await runTask(env, db, {
    taskType: channel.taskType,
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(channel.build({ profile: ctx.profile, markdown, tooLong })),
  });
  return result.text.trim();
}

/** FR-6.14: one translate call → a DR-9.14 outcome record. Requested-but-undeliverable is `failed`, never silent (FR-15.13). */
export async function translateArticle(
  env: Env,
  db: Db,
  ctx: { userId: string; runId: string | null },
  source: { title?: string; excerpt?: string; imageAlt?: string; markdown: string },
  targetLanguage: Language,
): Promise<TextDerivativeOutcome> {
  try {
    const result = await runTask(env, db, {
      taskType: "translate",
      userId: ctx.userId,
      runId: ctx.runId,
      input: toChatRequest(buildTranslatePrompt({ targetLanguage, source })),
    });
    const parsed = result.parsed as { title: string; excerpt: string; imageAlt: string; markdown: string };
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
export async function latestDerivativeRevision(db: Db, draftId: string): Promise<number> {
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
  const result = await translateArticle(
    env,
    db,
    { userId: args.userId, runId: args.runId },
    { title: args.title, markdown: args.markdown },
    args.targetLanguage,
  );
  const revisionNo = await latestDerivativeRevision(db, args.draftId);
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
  const revisionNo = await latestDerivativeRevision(db, draftId);
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

/** FR-6.13: hero image. Returned as base64 — the publishing step uploads it to Sanity
 * immediately (image bytes must never be a Workflow step return value: too large). */
export async function generateHeroImage(
  env: Env,
  db: Db,
  ctx: RunCtx,
  headline: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const result = await runImageTask(env, db, {
    taskType: "image",
    userId: ctx.userId,
    runId: ctx.runId,
    prompt: buildHeroImagePrompt({ headline, profile: ctx.profile }),
    size: "1536x1024",
  });
  return { imageBase64: result.imageBase64, mimeType: result.mimeType };
}

/** Spec §3 step 6: one call → the outline for the chosen angle (or another one, on request). */
export async function writeOutline(
  env: Env,
  db: Db,
  ctx: RunCtx,
  input: { topic: TopicBrief; angle: Angle; sources: Array<{ url: string; excerpt: string }>; instructions?: string },
): Promise<Outline> {
  const result = await runTask(env, db, {
    taskType: "outline",
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(buildOutlinePrompt({ profile: ctx.profile, ...input })),
  });
  return result.parsed as Outline;
}

/** Spec §3 step 8: one judge call merged with the deterministic checks. */
export async function checkQuality(
  env: Env,
  db: Db,
  ctx: RunCtx,
  input: { article: Article; outline: Outline | null; recentTopics: string[] },
): Promise<QualityCheck> {
  const result = await runTask(env, db, {
    taskType: "quality_check",
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(buildQualityCheckPrompt({ profile: ctx.profile, ...input })),
  });
  const { findings } = result.parsed as { findings: QualityCheck["findings"] };
  return mergeQuality(findings, deterministicChecks(ctx.profile, input.article));
}
