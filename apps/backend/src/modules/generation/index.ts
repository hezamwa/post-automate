// Bounded context: generation (AR-10.2) — angles, article, derivatives.
// All AI calls go through the router (AR-10.9); guardrails live in the prompts.
import type { Profile } from "@post-automate/shared";
import { runImageTask, runTask } from "../../ai/router";
import { articleSystem, primaryLanguage } from "../../ai/prompts/blocks";
import {
  anglesPrompt,
  anglesSchema,
  articleSchema,
  articleUser,
  imagePrompt,
  shortenLinkedInPrompt,
  shortenXPrompt,
  translatePrompt,
  type Angle,
  type TopicBrief,
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

/** FR-6.12/6.14 text derivatives — channel versions per profile.channels + translation for bilingual. */
export async function deriveTexts(env: Env, db: Db, ctx: RunCtx, article: Article): Promise<DerivedTexts> {
  const channels = ctx.profile.channels ?? ["x", "linkedin"];
  const out: DerivedTexts = {};

  if (channels.includes("x")) {
    out.xVersion = await boundedShorten(env, db, ctx, "shorten_x", shortenXPrompt(ctx.profile), article.markdown, 280);
  }
  if (channels.includes("linkedin")) {
    out.linkedinVersion = await boundedShorten(
      env, db, ctx, "shorten_linkedin", shortenLinkedInPrompt(ctx.profile), article.markdown, 3000,
    );
  }
  if (ctx.profile.language === "bilingual") {
    const result = await runTask(env, db, {
      taskType: "translate",
      userId: ctx.userId,
      runId: ctx.runId,
      input: {
        system: translatePrompt(ctx.profile),
        messages: [{ role: "user", content: article.markdown }],
        maxTokens: 16000,
      },
    });
    out.translatedMarkdown = result.text.trim();
  }
  return out;
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

export { primaryLanguage };
