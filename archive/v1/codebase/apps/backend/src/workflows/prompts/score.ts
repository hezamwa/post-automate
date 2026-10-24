import type { Profile } from "@post-automate/shared";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { TopicBrief } from "../../modules/discovery/types";

// Scoring (FR-5.2, design §6 "Template: scoring"): every candidate, with a reason.

export const PROMPT_VERSION = "v1";

export const scoresJsonSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          score: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["index", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

export function buildScorePrompt(input: { profile: Profile; candidates: TopicBrief[] }): PromptSpec {
  const { profile, candidates } = input;
  const interests = profile.topicPolicy.interests.map((i) => `${i.topic} (weight ${i.weight})`).join(", ");
  return {
    version: PROMPT_VERSION,
    system: [
      `You score topic candidates for this creator. Consider match to weighted interests [${interests}], audience fit [${profile.audience.description}], freshness, and whether the creator can add a distinctive angle. Score 1 (skip) to 10 (must write). Banned topics score 0 with reason "banned".`,
    ],
    messages: [
      {
        role: "user",
        content: candidates.map((c, i) => `#${i}: ${c.title} — ${c.summary} (why: ${c.whyItMatters})`).join("\n"),
      },
    ],
    jsonSchema: scoresJsonSchema,
    maxTokens: 3000,
  };
}
