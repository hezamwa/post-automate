import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { saveDraft } from "../../../src/workflows/steps/save-draft";
import { runStep } from "../../../src/workflows/steps/step";
import { draftRow, seedCandidates, stepContext } from "../harness";
import { ANGLES, CANDIDATES } from "../mocks";

// save-draft (spec §3 step 9): the drafts row — markdown is the editing source of truth (DR-9.11).
beforeEach(resetShared);

describe("save-draft step", () => {
  it("creates the pending draft with topic, angle and markdown", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    const { id } = await runStep(shared.step as never, ctx, saveDraft, { topicId: topic!.id, angle: ANGLES[1]!, markdown: "# Body" });
    expect(await draftRow(ctx.runId)).toMatchObject({ id, topicId: topic!.id, angle: ANGLES[1], markdown: "# Body", status: "pending_approval" });
    expect(shared.step.bills).toEqual([]);
  });
});
