import type { Profile } from "@post-automate/shared";
import type { PromptSpec } from "../../ai/prompts/spec";

// Spec §3 step 10 (FR-6.13): 2–3 hero-image concepts as text — the image itself is
// generated only for the chosen one. Medical profiles get abstract/schematic concepts.

export const PROMPT_VERSION = "v1";

export const imageConceptsJsonSchema = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          why: { type: "string" },
        },
        required: ["title", "description", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["concepts"],
  additionalProperties: false,
} as const;

export function buildImageConceptsPrompt(input: { profile: Profile; title: string; excerpt: string }): PromptSpec {
  const medical = input.profile.domain.field === "medical";
  return {
    version: PROMPT_VERSION,
    system: [
      `You propose editorial hero illustrations for articles by a ${input.profile.domain.field} creator. Give exactly 3 distinct concepts: a short title, a one-paragraph description an image model can render (subject, composition, mood, palette), and why it fits. Clean, modern, no text overlay, no logos.${medical ? " Abstract or schematic only — never realistic patients, procedures or identifiable people." : ""}`,
    ],
    messages: [{ role: "user", content: `Article title: ${input.title}\nExcerpt: ${input.excerpt}` }],
    jsonSchema: imageConceptsJsonSchema,
    maxTokens: 1500,
  };
}
