import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resetShared, shared } from "./preamble";
import { runTask } from "../../src/ai/router";
import { defineStep, RETRY, runStep } from "../../src/workflows/steps/step";
import { stepContext } from "./harness";

// The step contract (spec §3): input and output validated, output re-validated after
// (de)serialisation, listed errors non-retryable, everything else retried to the policy
// limit — and the one-billable-call-per-step invariant, proven to bite on a violator.

class Decision extends Error {}

const ping = (ctx: { env: unknown; userId: string }) =>
  runTask(ctx.env as never, shared.db, { taskType: "scoring", userId: ctx.userId, input: { messages: [] } });

beforeEach(resetShared);

describe("one billable call per step", () => {
  it("flags a step that bills twice in one attempt", async () => {
    const greedy = defineStep({
      name: "greedy",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      bills: "scoring",
      retries: RETRY.ai,
      run: async (ctx) => {
        await ping(ctx);
        await ping(ctx);
        return { n: 2 };
      },
    });
    await runStep(shared.step as never, await stepContext(), greedy, {});
    expect(shared.step.billingViolations()).toEqual([{ step: "greedy", calls: ["scoring", "scoring"] }]);
  });

  it("passes a step that bills once", async () => {
    const frugal = defineStep({
      name: "frugal",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      bills: "scoring",
      retries: RETRY.ai,
      run: async (ctx) => {
        await ping(ctx);
        return { n: 1 };
      },
    });
    await runStep(shared.step as never, await stepContext(), frugal, {});
    expect(shared.step.billingViolations()).toEqual([]);
    expect(shared.step.billedTasks("frugal")).toEqual(["scoring"]);
  });
});

describe("runStep contract", () => {
  const echo = defineStep({
    name: "echo",
    input: z.object({ n: z.number().int() }),
    output: z.object({ doubled: z.number(), at: z.coerce.date() }),
    retries: RETRY.io,
    run: async (_ctx, { n }) => ({ doubled: n * 2, at: new Date("2026-01-01T00:00:00Z") }),
  });

  it("rejects invalid input before step.do runs", async () => {
    await expect(runStep(shared.step as never, await stepContext(), echo, { n: 1.5 })).rejects.toThrow(z.ZodError);
    expect(shared.step.executed).toEqual([]);
  });

  it("validates the output inside the step and again after deserialisation", async () => {
    const out = await runStep(shared.step as never, await stepContext(), echo, { n: 2 });
    expect(out).toEqual({ doubled: 4, at: new Date("2026-01-01T00:00:00Z") });
    const liar = defineStep({ ...echo, name: "liar", run: async () => ({ doubled: "nope" }) as never });
    await expect(runStep(shared.step as never, await stepContext(), liar, { n: 1 })).rejects.toThrow(z.ZodError);
  });

  it("suffixes the step name so a loop can run the same step again", async () => {
    const ctx = await stepContext();
    await runStep(shared.step as never, ctx, echo, { n: 1 }, "rev1");
    await runStep(shared.step as never, ctx, echo, { n: 1 }, "rev2");
    expect(shared.step.executed).toEqual(["echo-rev1", "echo-rev2"]);
  });

  it("turns a listed error into NonRetryableError and does not retry it", async () => {
    const decides = defineStep({
      name: "decides",
      input: z.object({}),
      output: z.object({}),
      retries: RETRY.ai,
      nonRetryable: [Decision],
      run: async () => {
        throw new Decision("a decision");
      },
    });
    await expect(runStep(shared.step as never, await stepContext(), decides, {})).rejects.toThrow(NonRetryableError);
    expect(shared.step.attempts.get("decides")).toBe(1);
  });

  it("retries any other error up to the policy limit", async () => {
    let n = 0;
    const flaky = defineStep({
      name: "flaky",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      retries: RETRY.ai, // limit 2 → 3 attempts
      run: async () => {
        if (n++ < 2) throw new Error("blip");
        return { n };
      },
    });
    expect(await runStep(shared.step as never, await stepContext(), flaky, {})).toEqual({ n: 3 });
    expect(shared.step.attempts.get("flaky")).toBe(3);
  });
});
