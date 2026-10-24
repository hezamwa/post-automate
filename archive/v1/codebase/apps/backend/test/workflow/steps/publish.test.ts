import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { publish } from "../../../src/workflows/steps/publish";
import { runStep } from "../../../src/workflows/steps/step";
import { draftRow, runRow, seedDraftRow, stepContext } from "../harness";

// publish (spec §3 step 17, §6): every path through publishApprovedDraft; next_slot schedules.
beforeEach(resetShared);

async function reviewedDraft(ctx: Awaited<ReturnType<typeof stepContext>>) {
  const docId = `drafts.postauto-${ctx.runId}`;
  shared.sanity.docs.set(docId, { _id: docId, _type: "post", title: "T" });
  return seedDraftRow(ctx, { sanityDocumentId: docId });
}

describe("publish step", () => {
  it("now: publishes the Sanity draft, purges the markdown and closes the run", async () => {
    const ctx = await stepContext();
    const draftId = await reviewedDraft(ctx);
    expect(await runStep(shared.step as never, ctx, publish, { draftId, publishMode: "now" })).toEqual({ status: "published" });
    expect(await draftRow(ctx.runId)).toMatchObject({ status: "published", markdown: null, sanityDocumentId: `postauto-${ctx.runId}` });
    expect(shared.sanity.docs.get(`postauto-${ctx.runId}`)).toMatchObject({ datePublished: expect.any(String) });
    expect((await runRow(ctx.runId))?.state).toBe("published");
  });

  it("next_slot: schedules at the profile's next slot and marks the run publishing (FR-7.5)", async () => {
    const ctx = await stepContext();
    const draftId = await reviewedDraft(ctx);
    expect(await runStep(shared.step as never, ctx, publish, { draftId, publishMode: "next_slot" })).toEqual({ status: "scheduled" });
    const draft = await draftRow(ctx.runId);
    expect(draft).toMatchObject({ status: "scheduled", publishMode: "next_slot" });
    expect(draft?.publishAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await runRow(ctx.runId))?.state).toBe("publishing");
  });

  it("publishing.paused refuses the publish and leaves the draft pending (FR-15.12b)", async () => {
    const ctx = await stepContext();
    const draftId = await reviewedDraft(ctx);
    await shared.db.insert(schema.appConfig).values({ key: "publishing.paused", value: true });
    await expect(runStep(shared.step as never, ctx, publish, { draftId, publishMode: "now" })).rejects.toThrow(/Publishing is paused/);
    expect((await draftRow(ctx.runId))?.status).toBe("pending_approval");
  });
});
