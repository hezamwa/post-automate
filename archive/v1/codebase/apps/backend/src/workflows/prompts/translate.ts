import type { Language } from "@post-automate/shared";
import { LANGUAGE_NAMES } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";

// Translation (FR-6.14; design §6 "Templates: derivatives"). The target comes from
// profile.translation.targetLanguage — or the per-draft override — never from
// primaryLanguage. Structured output: the translated edition becomes its own Sanity
// document at publish (design §8), which needs title/excerpt/imageAlt in the target language.

export const PROMPT_VERSION = "v1";

export const translateJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    excerpt: { type: "string" },
    imageAlt: { type: "string" },
    markdown: { type: "string" },
  },
  required: ["title", "excerpt", "imageAlt", "markdown"],
  additionalProperties: false,
} as const;

export interface TranslateInput {
  targetLanguage: Language;
  source: { title?: string; excerpt?: string; imageAlt?: string; markdown: string };
}

export function buildTranslatePrompt({ targetLanguage, source }: TranslateInput): PromptSpec {
  const lang = LANGUAGE_NAMES[targetLanguage];
  return {
    version: PROMPT_VERSION,
    system: [
      `Translate the article below into ${lang}. Preserve the Markdown structure, tone, and the meaning of any disclaimer block exactly. Do not add or remove claims. Return title, excerpt (1-2 sentences) and imageAlt in ${lang} — translated from the originals when given, otherwise written from the article — plus the full translated markdown.`,
    ],
    messages: [
      {
        role: "user",
        content: [
          source.title ? `TITLE: ${source.title}` : null,
          source.excerpt ? `EXCERPT: ${source.excerpt}` : null,
          source.imageAlt ? `IMAGE ALT: ${source.imageAlt}` : null,
          `ARTICLE:\n${source.markdown}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    jsonSchema: translateJsonSchema,
    maxTokens: 16000,
  };
}
