import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { runStep } from "../../../src/workflows/steps/step";
import { writeSanityDraft } from "../../../src/workflows/steps/write-sanity-draft";
import { draftRow, seedDraftRow, stepContext } from "../harness";
import { article } from "../mocks";

// write-sanity-draft (spec §3 step 12): deterministic id, per-site mapping, produced texts carried.
beforeEach(resetShared);

describe("write-sanity-draft step", () => {
  it("writes drafts.postauto-{runId} with the image and provenance, and points the draft at it", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    const out = await runStep(shared.step as never, ctx, writeSanityDraft, {
      draftId, revisionNo: 0, article: article(), sourceUrls: ["https://a.example"], provider: "anthropic", model: "m", imageAssetId: "image-1", revised: false,
    });
    expect(out).toEqual({ sanityDocId: `drafts.postauto-${ctx.runId}` });
    expect(shared.sanity.docs.get(out.sanityDocId)).toMatchObject({
      _type: "post",
      image: { asset: { _ref: "image-1" } },
      generationMeta: { sourceUrls: ["https://a.example"], model: "m" },
    });
    // channel versions are patched on after approval by the derive steps, not written here
    expect(shared.sanity.docs.get(out.sanityDocId)).not.toHaveProperty("xVersion");
    expect((await draftRow(ctx.runId))?.sanityDocumentId).toBe(out.sanityDocId);
    expect(shared.step.bills).toEqual([]);
  });

  it("a revision refreshes the markdown and returns the draft to pending_approval", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx, { markdown: "# old", status: "revising" });
    await runStep(shared.step as never, ctx, writeSanityDraft, {
      draftId, revisionNo: 1, article: article("# new"), sourceUrls: [], provider: "p", model: "m", revised: true,
    }, "rev1");
    expect(await draftRow(ctx.runId)).toMatchObject({ markdown: "# new", status: "pending_approval" });
  });
});
