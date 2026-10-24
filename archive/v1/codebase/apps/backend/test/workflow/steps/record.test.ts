import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { z } from "zod";
import { record } from "../../../src/workflows/steps/record";
import { runStep } from "../../../src/workflows/steps/step";
import { draftRow, runRow, seedDraftRow, stepContext } from "../harness";

// record (spec §3 step 18): closes the run with one outcome per invocation.
beforeEach(resetShared);
const exec = (ctx: Awaited<ReturnType<typeof stepContext>>, input: Parameters<typeof record.run>[1], suffix: string) =>
  runStep(shared.step as never, ctx, record, input, suffix);

describe("record step", () => {
  it("skipped for pending drafts: state + reminder push (FR-7.4)", async () => {
    const ctx = await stepContext();
    await exec(ctx, { outcome: "skipped", reason: "2 drafts pending", kind: "pending_drafts" }, "skip");
    expect(await runRow(ctx.runId)).toMatchObject({ state: "skipped", error: "2 drafts pending", finishedAt: expect.any(Date) });
    expect(shared.pushes.map((p) => p.title)).toEqual(["Drafts waiting for your review"]);
  });

  it("skipped for a pause or no topic: state, no push", async () => {
    const ctx = await stepContext();
    await exec(ctx, { outcome: "skipped", reason: "paused", kind: "runs_paused" }, "skip");
    expect((await runRow(ctx.runId))?.state).toBe("skipped");
    expect(shared.pushes).toEqual([]);
  });

  it("failed: state with the message and a failure push (design §9)", async () => {
    const ctx = await stepContext();
    await exec(ctx, { outcome: "failed", message: "boom" }, "failure");
    expect(await runRow(ctx.runId)).toMatchObject({ state: "failed", error: "boom" });
    expect(shared.pushes[0]).toMatchObject({ title: "Pipeline run failed", body: "boom" });
  });

  it("rejected: deletes the Sanity draft, rejects with the category, purges markdown (FR-7.8)", async () => {
    const ctx = await stepContext();
    const docId = `drafts.postauto-${ctx.runId}`;
    shared.sanity.docs.set(docId, { _id: docId });
    const draftId = await seedDraftRow(ctx, { sanityDocumentId: docId });
    await exec(ctx, { outcome: "rejected", draftId, sanityDocId: docId, category: "changed_mind" }, "reject");
    expect(shared.sanity.docs.has(docId)).toBe(false);
    expect(await draftRow(ctx.runId)).toMatchObject({ status: "rejected", rejectionCategory: "changed_mind", markdown: null });
    expect(await runRow(ctx.runId)).toMatchObject({ state: "rejected", error: "rejected: changed_mind" });
  });

  it("stale: flags the draft, keeps everything, and does NOT close the run (spec §5.1)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx, { markdown: "# kept" });
    await exec(ctx, { outcome: "stale", draftId }, "stale");
    expect(await draftRow(ctx.runId)).toMatchObject({ status: "pending_approval", stale: true, markdown: "# kept" });
    expect(await runRow(ctx.runId)).toMatchObject({ state: "discovering", finishedAt: null });
  });

  it("refuses an unknown outcome", async () => {
    const ctx = await stepContext();
    await expect(exec(ctx, { outcome: "vanished" } as never, "x")).rejects.toThrow(z.ZodError);
  });
});
