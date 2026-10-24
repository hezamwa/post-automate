import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { outline } from "../../../src/workflows/steps/outline";
import { runStep } from "../../../src/workflows/steps/step";
import { runRow, seedCandidates, stepContext } from "../harness";
import { ANGLES, CANDIDATES, OUTLINE } from "../mocks";

// outline (spec §3 step 6): one call, grounded on the fetched sources, stored on the run.
beforeEach(resetShared);

describe("outline step", () => {
  it("bills one outline call, hands the source excerpts to the model, and stores the outline on the run", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    await shared.db.insert(schema.sources).values({ runId: ctx.runId, url: "https://src.example", title: "S", content: "The fetched page says X. ".repeat(500) });
    const out = await runStep(shared.step as never, ctx, outline, { topic: topic!, angle: ANGLES[0]! });
    expect(out).toEqual(OUTLINE);
    expect(shared.step.billedTasks("outline")).toEqual(["outline"]);
    const prompt = shared.ai.callsFor("outline")[0]!.input.messages[0]!.content;
    expect(prompt).toContain("https://src.example");
    expect(prompt.length).toBeLessThan(5000); // excerpt, not the whole page
    expect((await runRow(ctx.runId))?.outline).toEqual(OUTLINE);
  });

  it("passes the creator's request for a different outline into the prompt", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    await runStep(shared.step as never, ctx, outline, { topic: topic!, angle: ANGLES[0]!, instructions: "less history, more numbers" }, "regen1");
    expect(shared.ai.callsFor("outline")[0]!.input.messages[0]!.content).toContain("less history, more numbers");
  });
});
