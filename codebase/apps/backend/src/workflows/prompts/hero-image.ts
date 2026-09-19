import type { Profile } from "@post-automate/shared";

// Hero illustration prompt (FR-6.13; design §6 "image"). An image call takes a single
// string, not a chat spec — this is the one prompt file that returns text.

export const PROMPT_VERSION = "v1";

export function buildHeroImagePrompt(input: { headline: string; profile: Profile }): string {
  const medical =
    input.profile.domain.field === "medical"
      ? " Abstract/schematic only — no realistic patients, procedures, or identifiable people."
      : "";
  return `Editorial hero illustration for an article titled "${input.headline}". Clean, modern, no text overlay, no logos.${medical}`;
}
