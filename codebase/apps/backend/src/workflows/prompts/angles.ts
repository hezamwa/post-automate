import type { Profile } from "@post-automate/shared";
import { audienceBlock, guardrailsBlock, voiceBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { TopicBrief } from "../../modules/discovery/types";

// Angle proposal (FR-6.3 step 1, design §6 "Template: angle proposal"): 3 angles + a pick.

export const PROMPT_VERSION = "v1";

export const anglesJsonSchema = {
  type: "object",
  properties: {
    angles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          thesis: { type: "string" },
          whyThisCreator: { type: "string" },
          outline: { type: "array", items: { type: "string" } },
        },
        required: ["headline", "thesis", "whyThisCreator", "outline"],
        additionalProperties: false,
      },
    },
    recommendedIndex: { type: "integer" },
  },
  required: ["angles", "recommendedIndex"],
  additionalProperties: false,
} as const;

export function topicBriefText(topic: TopicBrief): string {
  return `TOPIC BRIEF:
Title: ${topic.title}
Summary: ${topic.summary}
Why now: ${topic.whyItMatters}
Sources: ${topic.sourceUrls.join(", ")}`;
}

export function buildAnglesPrompt(input: { profile: Profile; topic: TopicBrief }): PromptSpec {
  const { profile, topic } = input;
  return {
    version: PROMPT_VERSION,
    system: [
      `You propose article angles for this creator.`,
      voiceBlock(profile),
      audienceBlock(profile),
      guardrailsBlock(profile),
      `Propose exactly 3 distinct angles (headline, thesis, whyThisCreator, outline of 3-5 sections) and set recommendedIndex to the strongest one.`,
    ],
    messages: [{ role: "user", content: topicBriefText(topic) }],
    jsonSchema: anglesJsonSchema,
    maxTokens: 4000,
  };
}
