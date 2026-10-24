import type { Profile } from "@post-automate/shared";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { Article, Outline } from "../../modules/generation/types";
import { QUALITY_CHECKS } from "../../modules/generation/types";

// Spec §3 step 8: the finished article judged before review. Length and the disclaimer are
// also checked deterministically in code (modules/generation/quality.ts); the judge covers
// what needs reading: medical language, language, banned topics, similarity, outline.

export const PROMPT_VERSION = "v1";

export const qualityJsonSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          check: { type: "string", enum: [...QUALITY_CHECKS] },
          ok: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["check", "ok", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

export interface QualityCheckInput {
  profile: Profile;
  article: Article;
  outline: Outline | null;
  recentTopics: string[];
}

export function buildQualityCheckPrompt({ profile, article, outline, recentTopics }: QualityCheckInput): PromptSpec {
  const medical = profile.domain.field === "medical" && profile.compliance;
  return {
    version: PROMPT_VERSION,
    system: [
      `You are the editorial checker for a ${profile.domain.field} creator. Judge the article against each check and return one finding per check with a one-sentence note. Be strict about facts, lenient about style.`,
      [
        `Checks:`,
        `- disclaimer: ${medical ? `the article ends with this exact block: "${profile.compliance!.disclaimerText}"` : "not applicable — report ok"}`,
        `- medical_language: ${medical ? "no diagnosis, treatment recommendations for an individual, drug dosages or prescribing guidance; no real patients, cases or institutions" : "not applicable — report ok"}`,
        `- language: written entirely in ${profile.primaryLanguage === "ar" ? "Arabic" : "English"}`,
        `- length: roughly ~${profile.format?.targetWords ?? 1200} words`,
        `- banned_topics: nothing about ${profile.topicPolicy.bannedTopics.join("; ") || "(no banned topics)"}`,
        `- similarity: not a rehash of these recent topics: ${recentTopics.join("; ") || "(none)"}`,
        `- outline: the approved outline's sections are all covered${outline ? "" : " (no outline — report ok)"}`,
      ].join("\n"),
    ],
    messages: [
      {
        role: "user",
        content: [
          outline ? `APPROVED OUTLINE:\n${outline.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.keyPoints.join("; ")}`).join("\n")}` : "",
          `ARTICLE (title: ${article.title}):\n${article.markdown}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    jsonSchema: qualityJsonSchema,
    maxTokens: 2000,
  };
}
