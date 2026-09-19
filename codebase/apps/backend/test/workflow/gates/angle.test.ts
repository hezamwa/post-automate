import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { setRunAngleProposals } from "../../../src/db/commands";
import { angleGate, chooseAngle } from "../../../src/workflows/gates/angle";
import { FakeStep } from "../fake-step";
import { techProfile } from "../../fixtures";
import { runRow, stepContext } from "../harness";
import { ANGLES } from "../mocks";

// The angle gate (spec §4.3): the 3 stored proposals + recommendation; free text is a
// fourth angle appended to the run's proposals.
beforeEach(resetShared);
const proposals = { angles: ANGLES, recommendedIndex: 1 };

async function runWithAngles(gates: Partial<ReturnType<typeof techProfile>["gates"]> = {}) {
  const ctx = await stepContext({ profile: techProfile({ gates }) });
  await setRunAngleProposals(shared.db, ctx.runId, proposals);
  return ctx;
}

describe("angle gate", () => {
  it("renders the proposals as options with the recommendation", async () => {
    const ctx = await runWithAngles();
    expect(await angleGate.options(ctx)).toEqual({
      options: ANGLES.map((a, i) => ({ id: String(i), title: a.headline, summary: a.thesis, why: a.whyThisCreator })),
      recommended: "1",
    });
  });

  it("auto: the recommendation, recorded, no wait", async () => {
    const ctx = await runWithAngles();
    const { angle, index } = await chooseAngle(shared.step as never, ctx, proposals);
    expect([index, angle.headline]).toEqual([1, "Angle one"]);
    expect(shared.step.waits).toEqual([]);
    expect(await runRow(ctx.runId)).toMatchObject({ chosenAngleIndex: 1 });
    expect(await shared.db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, ctx.runId))).toMatchObject([{ gate: "angle", source: "auto" }]);
  });

  it("ask: the creator's pick wins, clamped to the proposals", async () => {
    const ctx = await runWithAngles({ angle: "ask" });
    shared.step.script({ type: "gate-angle", payload: { optionId: "2" } });
    expect((await chooseAngle(shared.step as never, ctx, proposals)).angle.headline).toBe("Angle two");
    const ctx2 = await runWithAngles({ angle: "ask" });
    shared.step = new FakeStep(); // a second run
    shared.step.script({ type: "gate-angle", payload: { optionId: "9" } });
    expect((await chooseAngle(shared.step as never, ctx2, proposals)).index).toBe(2);
  });

  it("free text becomes a fourth angle stored on the run (spec §4.3)", async () => {
    const ctx = await runWithAngles({ angle: "ask" });
    shared.step.script({ type: "gate-angle", payload: { freeText: "Why nobody ships agents on Fridays" } });
    const { angle, index, proposals: stored } = await chooseAngle(shared.step as never, ctx, proposals);
    expect(index).toBe(3);
    expect(angle).toMatchObject({ headline: "Why nobody ships agents on Fridays", outline: [] });
    expect(stored.angles).toHaveLength(4);
    expect((await runRow(ctx.runId))?.angleProposals).toMatchObject({ recommendedIndex: 1, angles: expect.any(Array) });
  });
});
