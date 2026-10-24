import { moodBlock, voiceBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import { shortenMessages, type ShortenInput } from "./derive-linkedin";

// X.com version of the article (FR-6.12; design §6 "Templates: derivatives").

export const PROMPT_VERSION = "v1";
export const X_MAX_CHARS = 280;

export function buildDeriveXPrompt(input: ShortenInput): PromptSpec {
  const { profile } = input;
  return {
    version: PROMPT_VERSION,
    system: [
      voiceBlock(profile),
      ...[moodBlock(input.mood)].filter(Boolean),
      `Compress the article below into ONE X.com post: MAXIMUM ${X_MAX_CHARS} characters including hashtags (hashtag policy: ${profile.voice.hashtagPolicy}). Language: ${profile.primaryLanguage}. Keep the hook, drop the detail, end with value — no clickbait. Reply with the post text only.`,
    ],
    messages: shortenMessages(input, X_MAX_CHARS),
    maxTokens: 8000,
  };
}

