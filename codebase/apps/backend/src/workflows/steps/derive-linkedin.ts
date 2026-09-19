import { channelStep } from "./derive-channel";

// Spec §3 step 15 (FR-6.12): the LinkedIn version, ≤ 3000 chars, from the final markdown.
export const deriveLinkedIn = channelStep("linkedin");
