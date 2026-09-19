import { z } from "zod";
import { profileSchema, type Profile } from "@post-automate/shared";
import type { Env } from "../shared/env";

// RunContext — what every step and gate receives (spec §2/§3). Everything except `env`
// is plain data rebuilt on every Workflow replay from the params and cached step outputs;
// it is never persisted as a blob. Emergency flags are deliberately NOT here: each step
// opens a fresh Db and re-reads them, so a pause reaches a parked run (design §10.1).

export const userTopicSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional(),
  links: z.array(z.string()).optional(),
});
export type UserTopic = z.infer<typeof userTopicSchema>;

/** Workflow instance params — sent by /runs/trigger, /runs/request and the dispatcher. */
export const pipelineParamsSchema = z.object({
  runId: z.string().uuid(),
  userId: z.string().uuid(),
  /** Set for user-requested runs (FR-5.8): research replaces discover + score. */
  userTopic: userTopicSchema.optional(),
});
export type PipelineParams = z.infer<typeof pipelineParamsSchema>;

/** The profile version pinned for the whole run by load-profile (spec §3 step 2). */
export const pinnedProfileSchema = z.object({
  version: z.number().int().positive(),
  profile: profileSchema,
});
export type PinnedProfile = z.infer<typeof pinnedProfileSchema>;

export interface RunContext extends PipelineParams {
  env: Env;
  pinned?: PinnedProfile;
  /** Gate choices recorded so far, keyed by gate name (spec §4.3). */
  choices: Record<string, unknown>;
  /** revise / change_angle counter (FR-7.9): 0 until the first revision. */
  revision: number;
}

export function createRunContext(env: Env, params: PipelineParams): RunContext {
  return { env, ...pipelineParamsSchema.parse(params), choices: {}, revision: 0 };
}

export function pinProfile(ctx: RunContext, pinned: PinnedProfile): void {
  ctx.pinned = pinnedProfileSchema.parse(pinned);
}

/** The pinned profile. Only the entry gates and load-profile itself may run without one. */
export function profileOf(ctx: RunContext): Profile {
  if (!ctx.pinned) throw new Error("profile not pinned — load-profile has not run yet (spec §3 step 2)");
  return ctx.pinned.profile;
}

/** The module-facing slice of the context (discovery/generation take {userId, runId, profile}). */
export function moduleCtx(ctx: RunContext): { userId: string; runId: string; profile: Profile } {
  return { userId: ctx.userId, runId: ctx.runId, profile: profileOf(ctx) };
}
