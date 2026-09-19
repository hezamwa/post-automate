import type { Profile } from "@post-automate/shared";
import { recencyBlock, searchResultsBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { FetchedResult } from "../../modules/discovery/types";

// Discovery → candidate topics (FR-5.4/5.5/5.7, design §6 "Template: discovery").
// Spec §3 step 3b: turns search snippets into 8–10 candidates; with no fetched results
// the model searches for itself (LLM-native path, billed per search).

export const PROMPT_VERSION = "v1";

export const candidatesJsonSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          whyItMatters: { type: "string" },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
        required: ["title", "summary", "whyItMatters", "sourceUrls"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

export interface SynthesizeCandidatesInput {
  profile: Profile;
  recentTopics: string[];
  fetched?: FetchedResult[];
}

export function buildSynthesizeCandidatesPrompt(input: SynthesizeCandidatesInput): PromptSpec {
  const { profile, recentTopics, fetched } = input;
  return {
    version: PROMPT_VERSION,
    system: [
      `You are a topic scout for a ${profile.domain.field} content creator. ${recencyBlock(profile)}`,
      fetched
        ? "Web search results are provided below — work only from them and do not invent sources; every candidate must cite at least one URL that appears there."
        : "Search the web before answering; every candidate must cite at least one real source URL.",
      `Exclude anything matching these banned topics: ${profile.topicPolicy.bannedTopics.join("; ") || "(none)"}.`,
      `Also exclude topics similar to these, covered or rejected in the last 30 days: ${recentTopics.join("; ") || "(none)"}.`,
    ],
    messages: [
      {
        role: "user",
        content: `Find 8-10 topics currently trending in: ${profile.domain.subNiches.join(", ")}. Return them as structured candidates.${
          fetched ? `\n\nSearch results:\n${searchResultsBlock(fetched)}` : ""
        }`,
      },
    ],
    jsonSchema: candidatesJsonSchema,
    maxTokens: 16000,
  };
}
