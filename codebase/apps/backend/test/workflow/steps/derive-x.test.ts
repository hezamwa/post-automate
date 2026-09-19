import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { GateError } from "../../../src/ai/gates";
import { NoRouteError } from "../../../src/ai/router";
import { runChannel } from "../../../src/workflows/steps/derive-channel";
import { deriveLinkedIn } from "../../../src/workflows/steps/derive-linkedin";
import { deriveX } from "../../../src/workflows/steps/derive-x";
import { techProfile } from "../../fixtures";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// derive-x / derive-linkedin (spec §3 steps 14–15): after approval, from the draft row's
// FINAL markdown; the FR-15.13 skip-not-fail matrix, the declined row (spec §7), the
// Sanity field patch, and the one corrective pass as its own step.
beforeEach(resetShared);

async function draftFor(profile = techProfile(), channels?: string[]) {
  const ctx = await stepContext({ profile });
  const docId = `drafts.postauto-${ctx.runId}`;
  shared.sanity.docs.set(docId, { _id: docId });
  const draftId = await seedDraftRow(ctx, { markdown: "# hello world", sanityDocumentId: docId, ...(channels ? { channels } : {}) });
  return { ctx, docId, input: { draftId, revisionNo: 0 } };
}

describe("derive-x step", () => {
  it("produces the X version from the draft's markdown with one call, its own row, and patches the Sanity draft", async () => {
    const { ctx, docId, input } = await draftFor();
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 10 });
    expect(shared.step.billedTasks("derive-x")).toEqual(["shorten_x"]);
    expect(shared.ai.callsFor("shorten_x")[0]!.input.messages[0]!.content).toBe("# hello world");
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "x", outcome: "produced", content: "short post", revisionNo: 0 }]);
    expect(shared.sanity.docs.get(docId)).toMatchObject({ xVersion: "short post" });
  });

  it("is absent — no call, no row — when the profile does not support the channel (design §5)", async () => {
    const { ctx, input } = await draftFor(techProfile({ channels: ["linkedin"] }));
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "absent" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(input.draftId)).toEqual([]);
  });

  it("is DECLINED — a row, no call — when the creator left it unticked at approval (spec §7)", async () => {
    const { ctx, input } = await draftFor(techProfile(), ["linkedin"]);
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "declined" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "x", outcome: "declined", reason: expect.stringContaining("unticked") }]);
  });

  it("SKIPS when the capability has no enabled route, with the reason on the row", async () => {
    const { ctx, input } = await draftFor();
    shared.ai.respondWith("shorten_x", () => {
      throw new NoRouteError("shorten_x");
    });
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("no enabled route") });
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "x", outcome: "skipped" }]);
  });

  it("marks an attempted-but-failing call FAILED with the reason", async () => {
    const { ctx, input } = await draftFor();
    shared.ai.respondWith("shorten_x", () => {
      throw new Error("provider exploded");
    });
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "failed", reason: "provider exploded" });
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "x", outcome: "failed", reason: "provider exploded" }]);
  });

  it("lets a GateError halt the step — pauses and caps are not derivative failures (FR-15.12a)", async () => {
    const { ctx, input } = await draftFor();
    shared.ai.respondWith("shorten_x", () => {
      throw new GateError("ai_paused", "AI is paused by an administrator");
    });
    await expect(runChannel(shared.step as never, ctx, deriveX, input)).rejects.toThrow(GateError);
    expect(await derivativeRows(input.draftId)).toEqual([]);
  });

  it("runs ONE corrective pass as a separate step when the answer exceeds 280 chars, keeping the shorter text", async () => {
    const { ctx, docId, input } = await draftFor();
    let n = 0;
    shared.ai.respondWith("shorten_x", () => (n++ === 0 ? "x".repeat(300) : "tight"));
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 5 });
    expect(shared.step.executed).toEqual(["derive-x", "derive-x-shorten"]);
    expect(shared.step.billingViolations()).toEqual([]);
    expect((await derivativeRows(input.draftId))[0]?.content).toBe("tight");
    expect(shared.sanity.docs.get(docId)).toMatchObject({ xVersion: "tight" });
  });

  it("keeps the first answer when the corrective pass comes back no shorter", async () => {
    const { ctx, input } = await draftFor();
    const long = "x".repeat(300);
    shared.ai.respondWith("shorten_x", () => long);
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 300 });
    expect((await derivativeRows(input.draftId))[0]?.content).toBe(long);
  });

  it("fails loudly when the draft's markdown is gone (purged, DR-9.11)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx, { markdown: null });
    await expect(runChannel(shared.step as never, ctx, deriveX, { draftId, revisionNo: 0 })).rejects.toThrow(/no markdown/);
  });
});

describe("derive-linkedin step", () => {
  it("produces the LinkedIn version with one call, its own row and field", async () => {
    const { ctx, docId, input } = await draftFor();
    expect(await runChannel(shared.step as never, ctx, deriveLinkedIn, input)).toMatchObject({ outcome: "produced" });
    expect(shared.step.billedTasks("derive-linkedin")).toEqual(["shorten_linkedin"]);
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "linkedin", outcome: "produced", content: "short post" }]);
    expect(shared.sanity.docs.get(docId)).toMatchObject({ linkedinVersion: "short post" });
  });
});
