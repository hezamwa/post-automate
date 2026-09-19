import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { research } from "../../../src/workflows/steps/research";
import { runStep } from "../../../src/workflows/steps/step";
import { candidateRows, runRow, stepContext } from "../harness";

// research (spec §3 step 3d, FR-5.8): user-topic runs only — one call, one selected candidate.
beforeEach(resetShared);

describe("research step", () => {
  it("bills one research call and persists a selected user candidate with its key facts", async () => {
    const userTopic = { title: "My own topic", links: ["https://x.example"] };
    const ctx = await stepContext({ userTopic });
    const topic = await runStep(shared.step as never, ctx, research, { userTopic });
    expect(shared.step.billedTasks("research")).toEqual(["research"]);
    expect(topic.summary).toContain("Key facts:\n- fact one");
    const rows = await candidateRows(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: topic.id, source: "user", selected: true });
    expect((await runRow(ctx.runId))?.state).toBe("drafting");
  });

  it("rejects an empty topic title", async () => {
    const ctx = await stepContext();
    await expect(runStep(shared.step as never, ctx, research, { userTopic: { title: "" } })).rejects.toThrow(/String must contain/);
  });
});
