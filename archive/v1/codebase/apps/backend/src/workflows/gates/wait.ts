import type { WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";
import { createDb } from "../../db/client";
import { notifyUser } from "../../shared/notify";
import type { RunContext } from "../context";
import { RETRY } from "../steps/step";
import type { GateDef } from "./gate";

// The `ask` wait (spec §4.2): 2 minutes silently — a creator who just tapped Generate is
// standing in the app — then a push, 3 days, a reminder push, 27 more days. Each wait is
// its own durable waitForEvent, so the sequence survives Worker restarts. null = no answer
// in 30 days; the caller abandons the run. Never auto-proceeds.

export const SILENT_WAIT: WorkflowSleepDuration = "2 minutes";
export const FIRST_WAIT: WorkflowSleepDuration = "3 days";
export const SECOND_WAIT: WorkflowSleepDuration = "27 days";

/** Workflows event types allow letters, digits, `-` and `_` only — so `gate-<name>`, not `gate:<name>`. */
export const gateEventType = (gate: string) => `gate-${gate}`;

async function waitOnce(step: WorkflowStep, name: string, type: string, timeout: WorkflowSleepDuration): Promise<unknown> {
  try {
    return (await step.waitForEvent(name, { type, timeout })).payload;
  } catch {
    return undefined; // timed out
  }
}

async function push(step: WorkflowStep, ctx: RunContext, name: string, msg: { title: string; body: string }): Promise<void> {
  await step.do(name, { retries: RETRY.io }, async () => {
    await notifyUser(ctx.env, createDb(ctx.env), ctx.userId, { ...msg, data: { runId: ctx.runId, gate: name.split("-")[1] ?? "" } });
    return { pushed: true };
  });
}

export async function waitForAnswer<T>(step: WorkflowStep, ctx: RunContext, gate: GateDef<T>, suffix?: string): Promise<T | null> {
  const tail = suffix ? `-${suffix}` : "";
  const type = gateEventType(gate.name);
  const parse = (raw: unknown) => gate.choice.parse(raw);

  const quick = await waitOnce(step, `gate-${gate.name}-wait-1${tail}`, type, SILENT_WAIT);
  if (quick !== undefined) return parse(quick);

  await push(step, ctx, `gate-${gate.name}-push${tail}`, {
    title: "Your input is needed",
    body: `Your article is waiting for your choice at the ${gate.name} step — open the app to continue.`,
  });
  const soon = await waitOnce(step, `gate-${gate.name}-wait-2${tail}`, type, FIRST_WAIT);
  if (soon !== undefined) return parse(soon);

  await push(step, ctx, `gate-${gate.name}-reminder${tail}`, {
    title: "Still waiting for your choice",
    body: `Three days ago an article paused at the ${gate.name} step. It will wait up to 30 days, then stop.`,
  });
  const late = await waitOnce(step, `gate-${gate.name}-wait-3${tail}`, type, SECOND_WAIT);
  return late === undefined ? null : parse(late);
}
