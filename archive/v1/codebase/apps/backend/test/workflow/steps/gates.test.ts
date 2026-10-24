import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { GateError } from "../../../src/ai/gates";
import { createRunContext } from "../../../src/workflows/context";
import { entryGates } from "../../../src/workflows/steps/gates";
import { runStep } from "../../../src/workflows/steps/step";
import { seedDraft, seedSpend } from "../../db/harness";
import { env } from "../preamble";
import { startRun } from "../harness";

// Entry gates step (spec §3 step 1): a skip is an outcome, a refusal is a decision.
beforeEach(resetShared);
const exec = (ctx: ReturnType<typeof createRunContext>) => runStep(shared.step as never, ctx, entryGates, {});

describe("entry gates step", () => {
  it("lets a runnable user through", async () => {
    expect(await exec(createRunContext(env, await startRun()))).toEqual({ ok: true });
  });

  it("skips with the kind when one draft is undecided (FR-7.4, spec §2)", async () => {
    const params = await startRun();
    await seedDraft(shared.db, params.userId, params.runId, "revising");
    expect(await exec(createRunContext(env, params))).toMatchObject({ ok: false, kind: "pending_drafts" });
  });

  it("holds a user-requested run to the same one-pending rule (spec §2)", async () => {
    const params = await startRun({ userTopic: { title: "mine" } });
    await seedDraft(shared.db, params.userId, params.runId, "pending_approval");
    expect(await exec(createRunContext(env, params))).toMatchObject({ ok: false, kind: "pending_drafts" });
  });

  it("treats a cap as a decision: GateError is non-retryable", async () => {
    const params = await startRun();
    await seedSpend(shared.db, params.userId, 10);
    expect(entryGates.nonRetryable).toContain(GateError);
    await expect(exec(createRunContext(env, params))).rejects.toThrow(NonRetryableError);
    expect(shared.step.attempts.get("gates")).toBe(1);
  });
});
