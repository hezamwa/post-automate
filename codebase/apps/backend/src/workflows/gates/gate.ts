import type { WorkflowStep } from "cloudflare:workers";
import type { GateName as ProfileGateName } from "@post-automate/shared";
import type { z } from "zod";
import { createDb } from "../../db/client";
import { recordGateChoice, setRunGate } from "../../db/commands";
import { profileOf, type RunContext } from "../context";
import { record } from "../steps/record";
import { RETRY, runStep } from "../steps/step";
import type { GateOptions, MultiSelectOptions } from "./options";
import { waitForAnswer } from "./wait";

// The Gate contract (spec §4). A gate is where the run pauses and offers the user a
// choice. resolveGate implements §4.2 for every gate except `draft`: auto → take the
// recommendation; ask → wait (2 minutes silently, push, 3 days, reminder, 27 days), and
// 30 days without an answer ends the run as `abandoned` — never auto-proceed. Every
// applied choice is a durable step, written to the run row AND the preference log.

export type GateName = ProfileGateName | "draft";

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

/** Thrown by resolveGate after the run has been recorded as abandoned; the pipeline stops quietly. */
export class RunAbandonedError extends Error {
  constructor(public gate: GateName) {
    super(`run abandoned at the ${gate} gate — 30 days without an answer (spec §4.2)`);
    this.name = "RunAbandonedError";
  }
}

export const ABANDON_AFTER = "30 days";

/** Apply a gate choice as a durable, retried step; clears the waiting marker and logs the choice. */
export async function applyGate<T>(
  step: WorkflowStep,
  ctx: RunContext,
  gate: GateDef<T>,
  choice: T,
  meta: { optionsShown: unknown; source: "user" | "auto" } = { optionsShown: {}, source: "user" },
  suffix?: string,
): Promise<T> {
  const parsed = gate.choice.parse(choice);
  await step.do(`gate-${gate.name}${suffix ? `-${suffix}` : ""}`, { retries: RETRY.io }, async () => {
    await gate.apply(ctx, parsed);
    const db = createDb(ctx.env);
    await setRunGate(db, ctx.runId, null);
    await recordGateChoice(db, { runId: ctx.runId, userId: ctx.userId, gate: gate.name, optionsShown: meta.optionsShown, choice: parsed, source: meta.source });
    return { applied: true };
  });
  ctx.choices[gate.name] = parsed;
  return parsed;
}

/** Spec §4.2 for every gate but `draft`. */
export async function resolveGate<T>(step: WorkflowStep, ctx: RunContext, gate: Exclude<GateDef<T>, { name: "draft" }>, suffix?: string): Promise<T> {
  if (gate.name === "draft") throw new Error("the draft gate is always ask and never resolved here (spec §4.1)");
  const options = await gate.options(ctx);
  if (profileOf(ctx).gates[gate.name] === "auto") {
    return applyGate(step, ctx, gate, await gate.recommended(ctx), { optionsShown: options, source: "auto" }, suffix);
  }
  await step.do(`gate-${gate.name}-open${suffix ? `-${suffix}` : ""}`, { retries: RETRY.io }, async () => {
    await setRunGate(createDb(ctx.env), ctx.runId, gate.name);
    return { waiting: true };
  });
  const answer = await waitForAnswer(step, ctx, gate, suffix);
  if (answer === null) {
    await runStep(step, ctx, record, { outcome: "abandoned", gate: gate.name }, `abandoned-${gate.name}${suffix ? `-${suffix}` : ""}`);
    throw new RunAbandonedError(gate.name);
  }
  return applyGate(step, ctx, gate, answer, { optionsShown: options, source: "user" }, suffix);
}
