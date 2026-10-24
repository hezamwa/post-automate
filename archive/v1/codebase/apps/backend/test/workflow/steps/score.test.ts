import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { z } from "zod";
import { score } from "../../../src/workflows/steps/score";
import { runStep } from "../../../src/workflows/steps/step";
import { candidateRows, runRow, seedCandidates, stepContext } from "../harness";
import { CANDIDATES } from "../mocks";

// score (spec §3 step 3c, FR-5.2): one call, every candidate persisted with a reason.
beforeEach(resetShared);

describe("score step", () => {
  it("bills one scoring call, persists scores and selects the best ≥ 6, run → drafting", async () => {
    const ctx = await stepContext();
    const candidates = await seedCandidates(ctx, CANDIDATES);
    const topic = await runStep(shared.step as never, ctx, score, { candidates });
    expect(shared.step.billedTasks("score")).toEqual(["scoring"]);
    expect(topic).toMatchObject({ id: candidates[0]!.id, title: "Agents in production" });
    const rows = await candidateRows(ctx.runId);
    expect(rows.map((r) => [Number(r.score), r.selected]).sort()).toEqual([[4, false], [7, false], [8, true]]);
    expect(rows.find((r) => r.selected)?.rejectionReason).toBeNull();
    expect((await runRow(ctx.runId))?.state).toBe("drafting");
  });

  it("returns null when nothing qualifies, leaving the run state alone", async () => {
    const ctx = await stepContext();
    const candidates = await seedCandidates(ctx, CANDIDATES);
    shared.ai.respondWith("scoring", () => ({ scores: [{ index: 0, score: 5, reason: "close" }] }));
    expect(await runStep(shared.step as never, ctx, score, { candidates })).toBeNull();
    expect((await candidateRows(ctx.runId)).some((r) => r.selected)).toBe(false);
    expect((await runRow(ctx.runId))?.state).toBe("discovering");
  });

  it("rejects candidates that were never persisted (no id)", async () => {
    const ctx = await stepContext();
    await expect(runStep(shared.step as never, ctx, score, { candidates: CANDIDATES as never })).rejects.toThrow(z.ZodError);
  });
});
