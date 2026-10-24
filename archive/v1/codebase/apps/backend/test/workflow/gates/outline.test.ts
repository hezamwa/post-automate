import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { chooseOutline, outlineGate } from "../../../src/workflows/gates/outline";
import { techProfile } from "../../fixtures";
import { runRow, seedCandidates, stepContext } from "../harness";
import { ANGLES, CANDIDATES, OUTLINE } from "../mocks";

// The outline gate (spec §4.3): approve, edit sections, or ask for another (free text →
// regenerated, bounded). The approved outline is what the draft follows.
beforeEach(resetShared);

async function ready(gates: Partial<ReturnType<typeof techProfile>["gates"]> = {}) {
  const ctx = await stepContext({ profile: techProfile({ gates }) });
  const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
  return { ctx, input: { topic: topic!, angle: ANGLES[1]! } };
}

describe("outline gate", () => {
  it("auto: generates once, approves the recommendation, records it", async () => {
    const { ctx, input } = await ready();
    expect(await chooseOutline(shared.step as never, ctx, input)).toEqual(OUTLINE);
    expect(shared.step.executed).toEqual(["outline", "gate-outline"]);
    expect(await shared.db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, ctx.runId))).toMatchObject([{ gate: "outline", source: "auto", choice: { optionId: "approve" } }]);
  });

  it("renders the outline as one option the creator can approve", async () => {
    const { ctx, input } = await ready();
    await chooseOutline(shared.step as never, ctx, input);
    const options = await outlineGate.options(ctx);
    expect(options.options[0]).toMatchObject({ id: "approve", title: "3 sections", summary: expect.stringContaining("1. Why now — the trigger") });
  });

  it("ask: edited sections replace the outline the draft will follow", async () => {
    const { ctx, input } = await ready({ outline: "ask" });
    const edited = [{ heading: "My own first section", keyPoints: ["mine"] }, { heading: "Then this", keyPoints: [] }];
    shared.step.script({ type: "gate-outline", payload: { sections: edited } });
    expect(await chooseOutline(shared.step as never, ctx, input)).toEqual({ sections: edited });
    expect((await runRow(ctx.runId))?.outline).toEqual({ sections: edited });
    expect(shared.ai.callsFor("outline")).toHaveLength(1);
  });

  it("ask: free text regenerates the outline with the instructions, then the next answer approves it", async () => {
    const { ctx, input } = await ready({ outline: "ask" });
    let n = 0;
    shared.ai.respondWith("outline", () => (n++ === 0 ? OUTLINE : { sections: [{ heading: "Numbers first", keyPoints: ["as asked"] }, { heading: "Then why", keyPoints: [] }] }));
    shared.step.script({ type: "gate-outline", payload: { freeText: "start with the numbers" } }, { type: "gate-outline", payload: { optionId: "approve" } });
    const approved = await chooseOutline(shared.step as never, ctx, input);
    expect(approved.sections[0]?.heading).toBe("Numbers first");
    expect(shared.step.executed).toEqual(["outline", "gate-outline-open", "gate-outline", "outline-regen1", "gate-outline-open-regen1", "gate-outline-regen1"]);
    expect(shared.ai.callsFor("outline")[1]!.input.messages[0]!.content).toContain("start with the numbers");
    expect(shared.step.billingViolations()).toEqual([]);
  });

  it("ask: regeneration is bounded — after the cap the latest outline stands", async () => {
    const { ctx, input } = await ready({ outline: "ask" });
    const again = { type: "gate-outline", payload: { freeText: "another one" } };
    shared.step.script(again, again, again, again);
    await chooseOutline(shared.step as never, ctx, input);
    expect(shared.ai.callsFor("outline")).toHaveLength(3); // initial + 2 regenerations
  });
});
