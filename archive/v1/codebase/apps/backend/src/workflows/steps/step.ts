import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { z } from "zod";
import type { TaskType } from "@post-automate/shared";
import type { RunContext } from "../context";

// The Step contract (spec §3). A step is thin — validate, one module call or one ai.run,
// persist, return a small typed output — and step.do is the retry boundary: at most ONE
// billable provider call per step, so a retry can never re-bill a call that succeeded.

export type RetryPolicy = NonNullable<WorkflowStepConfig["retries"]>;

export const RETRY = {
  /** Provider calls — the policy every v1 AI step used. */
  ai: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  /** DB / Sanity / push writes: quick, cheap, idempotent. */
  io: { limit: 3, delay: "5 seconds", backoff: "exponential" },
} as const satisfies Record<string, RetryPolicy>;

type ErrorClass = abstract new (...args: never[]) => Error;

export interface StepDef<I, O> {
  /** Matches the spec's step name exactly (spec §3 table). */
  name: string;
  // Typed on the OUTPUT side only (third parameter `unknown`): zod ties Input to Output by
  // default, which would make defaulted fields look optional to callers.
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  /** The ONE task type this step may bill — absent for pure persistence steps. */
  bills?: TaskType;
  retries: RetryPolicy;
  /** Errors that are decisions, not failures (e.g. CANNOT_COMPLY) — thrown as NonRetryableError. */
  nonRetryable?: readonly ErrorClass[];
  run(ctx: RunContext, input: I): Promise<O>;
}

export function defineStep<I, O>(def: StepDef<I, O>): StepDef<I, O> {
  return def;
}

/** Step names must be unique per run; repeated invocations (revision loops) carry a suffix. */
/**
 * A WorkflowStep for code running OUTSIDE the engine — direct handling of a draft whose
 * instance is gone (spec §5.1): steps execute immediately, no durability, no retries, no
 * waiting. The same step definitions and the same orchestration functions run either way.
 */
export function inlineStep(): WorkflowStep {
  const run = async (_name: string, configOrFn: unknown, maybeFn?: unknown) =>
    ((typeof configOrFn === "function" ? configOrFn : maybeFn) as (ctx: unknown) => Promise<unknown>)({});
  return {
    do: run,
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => {
      throw new Error("an inline step cannot wait for events — only a live Workflow instance can (spec §5.1)");
    },
  } as unknown as WorkflowStep;
}

export function stepName(def: { name: string }, suffix?: string): string {
  return suffix ? `${def.name}-${suffix}` : def.name;
}

/**
 * Run a step inside step.do. Input is validated before, output inside — and again after
 * Workflows (de)serialisation, the profileSchema.parse pattern applied to every step.
 */
export async function runStep<I, O>(
  step: WorkflowStep,
  ctx: RunContext,
  def: StepDef<I, O>,
  input: I,
  suffix?: string,
): Promise<O> {
  const parsedInput = def.input.parse(input);
  const raw: unknown = await step.do(stepName(def, suffix), { retries: def.retries }, async () => {
    try {
      return def.output.parse(await def.run(ctx, parsedInput)) as never;
    } catch (e) {
      if (def.nonRetryable?.some((cls) => e instanceof cls)) {
        throw new NonRetryableError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  });
  return def.output.parse(raw);
}
