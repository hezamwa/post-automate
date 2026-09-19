import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { GateError } from "../../../src/ai/gates";
import { NoRouteError } from "../../../src/ai/router";
import { runChannel } from "../../../src/workflows/steps/derive-channel";
import { deriveLinkedIn } from "../../../src/workflows/steps/derive-linkedin";
import { deriveX } from "../../../src/workflows/steps/derive-x";
import { techProfile } from "../../fixtures";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// derive-x / derive-linkedin (spec §3 steps 14–15): the FR-15.13 skip-not-fail matrix per
// step, plus the one corrective pass as its own step.
beforeEach(resetShared);

async function draftFor(profile = techProfile()) {
  const ctx = await stepContext({ profile });
  const draftId = await seedDraftRow(ctx);
  return { ctx, input: { draftId, revisionNo: 0, markdown: "# hello world" } };
}

describe("derive-x step", () => {
  it("produces the X version with one call and its own row", async () => {
    const { ctx, input } = await draftFor();
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 10 });
    expect(shared.step.billedTasks("derive-x")).toEqual(["shorten_x"]);
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "x", outcome: "produced", content: "short post", revisionNo: 0 }]);
  });

  it("is absent — no call, no row — when the profile did not ask for the channel (design §5)", async () => {
    const { ctx, input } = await draftFor(techProfile({ channels: ["linkedin"] }));
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "absent" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(input.draftId)).toEqual([]);
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
    const { ctx, input } = await draftFor();
    const long = "x".repeat(300);
    let n = 0;
    shared.ai.respondWith("shorten_x", () => (n++ === 0 ? long : "tight"));
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 5 });
    expect(shared.step.executed).toEqual(["derive-x", "derive-x-shorten"]);
    expect(shared.step.billingViolations()).toEqual([]);
    expect((await derivativeRows(input.draftId))[0]?.content).toBe("tight");
  });

  it("keeps the first answer when the corrective pass comes back no shorter", async () => {
    const { ctx, input } = await draftFor();
    const long = "x".repeat(300);
    shared.ai.respondWith("shorten_x", () => long);
    expect(await runChannel(shared.step as never, ctx, deriveX, input)).toEqual({ outcome: "produced", length: 300 });
    expect((await derivativeRows(input.draftId))[0]?.content).toBe(long);
  });
});

describe("derive-linkedin step", () => {
  it("produces the LinkedIn version with one call and its own row", async () => {
    const { ctx, input } = await draftFor();
    expect(await runChannel(shared.step as never, ctx, deriveLinkedIn, input)).toMatchObject({ outcome: "produced" });
    expect(shared.step.billedTasks("derive-linkedin")).toEqual(["shorten_linkedin"]);
    expect(await derivativeRows(input.draftId)).toMatchObject([{ kind: "linkedin", outcome: "produced", content: "short post" }]);
  });
});
