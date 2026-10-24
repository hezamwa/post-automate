import { channelStep } from "./derive-channel";

// Spec §3 step 14 (FR-6.12): the X.com version, ≤ 280 chars, from the final markdown.
export const deriveX = channelStep("x");
