import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { runStep } from "../../../src/workflows/steps/step";
import { synthesizeCandidates } from "../../../src/workflows/steps/synthesize-candidates";
import { candidateRows, runRow, stepContext } from "../harness";

// synthesize-candidates (spec §3 step 3b, FR-5.4): one call, every candidate persisted (DR-9.3).
beforeEach(resetShared);

describe("synthesize-candidates step", () => {
  it("persists every candidate, moves the run to scoring, bills one discovery call", async () => {
    const ctx = await stepContext();
    const out = await runStep(shared.step as never, ctx, synthesizeCandidates, { fetched: null });
    expect(out).toHaveLength(3);
    expect(await candidateRows(ctx.runId)).toHaveLength(3);
    expect((await runRow(ctx.runId))?.state).toBe("scoring");
    expect(shared.step.billedTasks("synthesize-candidates")).toEqual(["discovery"]);
    expect(shared.ai.callsFor("discovery")[0]!.input.webSearch).toBe(true); // nothing fetched → LLM-native
  });

  it("hands fetched snippets to the model and tells it not to search", async () => {
    const ctx = await stepContext();
    await runStep(shared.step as never, ctx, synthesizeCandidates, { fetched: [{ title: "Fetched", url: "https://f.example", snippet: "x" }] });
    const call = shared.ai.callsFor("discovery")[0]!.input;
    expect(call.webSearch).toBe(false);
    expect(call.messages[0]!.content).toContain("Fetched");
  });
});
