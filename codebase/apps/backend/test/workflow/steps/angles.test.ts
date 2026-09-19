import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { angles } from "../../../src/workflows/steps/angles";
import { runStep } from "../../../src/workflows/steps/step";
import { runRow, seedCandidates, stepContext } from "../harness";
import { ANGLES, CANDIDATES } from "../mocks";

// angles (spec §3 step 5, FR-6.3): one call, proposals stored on the run for the picker.
beforeEach(resetShared);

describe("angles step", () => {
  it("bills one angles call and persists the proposals on the run", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    const out = await runStep(shared.step as never, ctx, angles, { topic: topic! });
    expect(shared.step.billedTasks("angles")).toEqual(["angles"]);
    expect(out).toEqual({ angles: ANGLES, recommendedIndex: 1 });
    expect((await runRow(ctx.runId))?.angleProposals).toEqual(out);
  });

  it("clamps an out-of-range recommendation", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    shared.ai.respondWith("angles", () => ({ angles: ANGLES, recommendedIndex: 9 }));
    expect((await runStep(shared.step as never, ctx, angles, { topic: topic! })).recommendedIndex).toBe(2);
  });
});
