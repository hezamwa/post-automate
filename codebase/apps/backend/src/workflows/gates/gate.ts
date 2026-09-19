import type { WorkflowStep } from "cloudflare:workers";
import type { z } from "zod";
import type { RunContext } from "../context";
import { RETRY } from "../steps/step";
import type { GateOptions, MultiSelectOptions } from "./options";

// The Gate contract (spec §4). A gate is where the run pauses and offers the user a
// choice; `resolveGate` (spec §4.2 — lands with the gate framework phase) decides whether
// the user sees it. Every applied choice is a durable step, so a replay never re-applies.

export type GateName = "topic" | "angle" | "outline" | "image" | "draft" | "derivatives" | "publish";

export interface GateDef<TChoice> {
  name: GateName;
  /** What the user sees. */
  options(ctx: RunContext): Promise<GateOptions | MultiSelectOptions>;
  /** Option id | free text | multi-select set | decision payload. */
  choice: z.ZodType<TChoice, z.ZodTypeDef, unknown>;
  /** Used when the gate setting is "auto". */
  recommended(ctx: RunContext): Promise<TChoice>;
  /** Persist the choice on the run row (and whatever the choice changes). */
  apply(ctx: RunContext, choice: TChoice): Promise<void>;
}

export function defineGate<T>(def: GateDef<T>): GateDef<T> {
  return def;
}

/** Apply a gate choice as a durable, retried step and record it on the context. */
export async function applyGate<T>(
  step: WorkflowStep,
  ctx: RunContext,
  gate: GateDef<T>,
  choice: T,
  suffix?: string,
): Promise<T> {
  const parsed = gate.choice.parse(choice);
  await step.do(`gate-${gate.name}${suffix ? `-${suffix}` : ""}`, { retries: RETRY.io }, async () => {
    await gate.apply(ctx, parsed);
    return { applied: true };
  });
  ctx.choices[gate.name] = parsed;
  return parsed;
}
