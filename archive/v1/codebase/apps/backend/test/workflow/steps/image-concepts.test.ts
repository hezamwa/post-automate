import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { imageConcepts } from "../../../src/workflows/steps/image-concepts";
import { runStep } from "../../../src/workflows/steps/step";
import { runRow, stepContext } from "../harness";

// image-concepts (spec §3 step 10): 2–3 concepts as text, one call, no image yet.
beforeEach(resetShared);

describe("image-concepts step", () => {
  it("bills one concepts call, ids the concepts, and stores them on the run", async () => {
    const ctx = await stepContext();
    const out = await runStep(shared.step as never, ctx, imageConcepts, { title: "T", excerpt: "E" });
    expect(out.concepts.map((c) => [c.id, c.title])).toEqual([["c1", "Abstract network"], ["c2", "Workshop bench"], ["c3", "Lighthouse"]]);
    expect(shared.step.billedTasks("image-concepts")).toEqual(["image_concepts"]);
    expect(shared.ai.callsFor("image")).toHaveLength(0);
    expect((await runRow(ctx.runId))?.imageConcepts).toEqual(out);
  });
});
