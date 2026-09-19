import type { Profile } from "@post-automate/shared";
import { voiceBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { ChatMessage } from "../../ai/types";

// LinkedIn version of the article (FR-6.12; design §6 "Templates: derivatives").

export const PROMPT_VERSION = "v1";
export const LINKEDIN_MAX_CHARS = 3000;

export interface ShortenInput {
  profile: Profile;
  markdown: string;
  /** A previous answer that exceeded the channel limit — asks for a shorter rewrite. */
  tooLong?: string;
}

/** Shared by both channel prompts: the article, plus the corrective turn when a first answer ran long. */
export function shortenMessages(input: ShortenInput, maxChars: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: input.markdown }];
  if (input.tooLong) {
    messages.push(
      { role: "assistant", content: input.tooLong },
      { role: "user", content: `That is ${input.tooLong.length} characters — the hard limit is ${maxChars}. Rewrite it shorter.` },
    );
  }
  return messages;
}

export function buildDeriveLinkedInPrompt(input: ShortenInput): PromptSpec {
  const { profile } = input;
  return {
    version: PROMPT_VERSION,
    system: [
      voiceBlock(profile),
      `Rewrite the article below as ONE LinkedIn post (max ${LINKEDIN_MAX_CHARS} characters; professional register; language: ${profile.primaryLanguage}). Structure: a strong first line (it shows before "see more"), 2-4 short paragraphs of substance, a closing line inviting the full read. At most 3 hashtags. Reply with the post text only.`,
    ],
    messages: shortenMessages(input, LINKEDIN_MAX_CHARS),
    maxTokens: 8000,
  };
}
