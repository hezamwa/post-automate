import type { Profile } from "@post-automate/shared";
import { searchResultsBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { FetchedResult } from "../../modules/discovery/types";
import type { UserTopic } from "../context";

// Targeted research for a user-chosen topic (FR-5.8, design §6 "Template: targeted research").

export const PROMPT_VERSION = "v1";

export const researchJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    whyItMatters: { type: "string" },
    keyFacts: { type: "array", items: { type: "string" } },
    sourceUrls: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "whyItMatters", "keyFacts", "sourceUrls"],
  additionalProperties: false,
} as const;

export interface ResearchInput {
  profile: Profile;
  topic: UserTopic;
  fetched?: FetchedResult[];
}

export function buildResearchPrompt({ profile, topic, fetched }: ResearchInput): PromptSpec {
  return {
    version: PROMPT_VERSION,
    system: [
      `You research one specific topic for a ${profile.domain.field} content creator. The creator chose it — do not judge whether it is trending. ${
        fetched
          ? "Web search results are provided below — work only from them and the creator's links, and do not invent sources."
          : "Search the web; treat the creator's provided links as primary sources."
      } Every key fact must tie to a source URL.`,
    ],
    messages: [
      {
        role: "user",
        content: `Topic: "${topic.title}"\nCreator notes: ${topic.notes ?? "(none)"}\nProvided sources: ${topic.links?.join(", ") ?? "(none)"}\nReturn a structured topic brief.${
          fetched ? `\n\nSearch results:\n${searchResultsBlock(fetched)}` : ""
        }`,
      },
    ],
    jsonSchema: researchJsonSchema,
    maxTokens: 16000,
  };
}
