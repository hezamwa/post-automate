import { z } from "zod";

// Per-article mood (FR-6.19–6.20, OD-28): chosen at Generate / My topic, stored on the run,
// applied to the article and its channel versions. It adjusts the profile's voice — it
// never replaces it. `critical` is refused for a profile with medical guardrails.

export const MOODS = ["normal", "optimistic", "excited", "very_excited", "concerned", "disappointed", "critical"] as const;
export const moodSchema = z.enum(MOODS);
export type Mood = z.infer<typeof moodSchema>;

/** Moods never offered or accepted for a profile with medical guardrails (FR-6.20). */
export const MEDICAL_BLOCKED_MOODS: readonly Mood[] = ["critical"];
