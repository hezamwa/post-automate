import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { recordDerivatives } from "../../../src/db/commands";
import { publishGate, resolvePublish } from "../../../src/workflows/gates/publish";
import { techProfile } from "../../fixtures";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// The publish gate (spec §4.3): now / next slot / hold with the produced derivative texts;
// auto = the approval's publishMode; edits to a derivative text ride along.
beforeEach(resetShared);

async function withDerivatives(gates = {}) {
  const ctx = await stepContext({ profile: techProfile({ gates }) });
  const docId = `drafts.postauto-${ctx.runId}`;
  shared.sanity.docs.set(docId, { _id: docId });
  const draftId = await seedDraftRow(ctx, { sanityDocumentId: docId });
  await recordDerivatives(shared.db, draftId, 0, [
    { kind: "x", outcome: "produced", content: "the x post" },
    { kind: "linkedin", outcome: "failed", reason: "route down" },
  ]);
  return { ctx, draftId, docId };
}

describe("publish gate", () => {
  it("shows the produced derivative texts (and why one is missing) on every option", async () => {
    const { ctx } = await withDerivatives();
    const options = await publishGate.options(ctx);
    expect(options.options.map((o) => o.id)).toEqual(["now", "next_slot", "hold"]);
    expect(options.options[0]?.summary).toContain("x: the x post");
    expect(options.options[0]?.summary).toContain("linkedin: failed — route down");
  });

  it("auto: the publishMode given at approval", async () => {
    const { ctx } = await withDerivatives();
    ctx.choices.draft = { action: "approve", publishMode: "next_slot" };
    expect(await resolvePublish(shared.step as never, ctx)).toBe("next_slot");
    expect(shared.step.waits).toEqual([]);
    ctx.choices.draft = { action: "approve" };
    const { FakeStep } = await import("../fake-step");
    shared.step = new FakeStep();
    expect(await resolvePublish(shared.step as never, ctx)).toBe("now");
  });

  it("ask: the answer decides, and edits replace the produced text and the Sanity field", async () => {
    const { ctx, draftId, docId } = await withDerivatives({ publish: "ask" });
    shared.step.script({ type: "gate-publish", payload: { optionId: "hold", edits: { x: "tighter x post" } } });
    expect(await resolvePublish(shared.step as never, ctx)).toBe("hold");
    expect((await derivativeRows(draftId)).find((d) => d.kind === "x")?.content).toBe("tighter x post");
    expect(shared.sanity.docs.get(docId)).toMatchObject({ xVersion: "tighter x post" });
  });

  it("rejects an edit over the channel limit or an unknown option", async () => {
    const { ctx } = await withDerivatives({ publish: "ask" });
    shared.step.script({ type: "gate-publish", payload: { optionId: "now", edits: { x: "x".repeat(281) } } });
    await expect(resolvePublish(shared.step as never, ctx)).rejects.toThrow();
  });
});
