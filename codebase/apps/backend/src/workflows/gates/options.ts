import { z } from "zod";

// The one option shape every option-producing step returns (spec §4), so Flutter has one
// review screen and the workflow one handler.

export const gateOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  why: z.string(),
});
export type GateOption = z.infer<typeof gateOptionSchema>;

export const gateOptionsSchema = z.object({
  options: z.array(gateOptionSchema).min(1),
  recommended: z.string(),
});
export type GateOptions = z.infer<typeof gateOptionsSchema>;

/** The derivatives gate: any subset, pre-ticked from the profile (spec §4.1). */
export const multiSelectOptionsSchema = z.object({
  options: z.array(gateOptionSchema),
  preselected: z.array(z.string()),
});
export type MultiSelectOptions = z.infer<typeof multiSelectOptionsSchema>;
