import type { Profile } from "@post-automate/shared";

// Hero illustration prompt (FR-6.13; design §6 "image"): the chosen concept (spec §3 step
// 10) rendered for the article. An image call takes a single string, not a chat spec —
// this is the one prompt file that returns text.

export const PROMPT_VERSION = "v2";

export function buildHeroImagePrompt(input: { headline: string; concept?: string | null; profile: Profile }): string {
  const medical =
    input.profile.domain.field === "medical"
      ? " Abstract/schematic only — no realistic patients, procedures, or identifiable people."
      : "";
  const concept = input.concept ? ` Concept: ${input.concept}` : "";
  return `Editorial hero illustration for an article titled "${input.headline}".${concept} Clean, modern, no text overlay, no logos.${medical}`;
}
