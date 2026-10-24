import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { GateError } from "../../../src/ai/gates";
import { NoRouteError } from "../../../src/ai/router";
import { heroImage } from "../../../src/workflows/steps/hero-image";
import { runStep } from "../../../src/workflows/steps/step";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// hero-image (spec §3 step 11, FR-6.13): one image call, upload, only the reference returned.
beforeEach(resetShared);
const article = { title: "Title", slug: "title" };

describe("hero-image step", () => {
  it("generates the CHOSEN concept once, uploads, records the row and returns only the asset reference", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    const out = await runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 0, article, concept: "Glowing nodes on a dark field" });
    expect(out).toEqual({ outcome: "produced", assetRef: "image-fake-asset" });
    expect(shared.ai.callsFor("image")[0]!.input.messages[0]!.content).toContain("Concept: Glowing nodes on a dark field");
    expect(shared.step.billedTasks("hero-image")).toEqual(["image"]);
    expect(JSON.stringify(out)).not.toContain("AAAA"); // bytes never leave the step
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "hero_image", outcome: "produced", assetRef: "image-fake-asset" }]);
  });

  it("\"no hero image\" at the image gate → declined row, no call (spec §4.3)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 0, article, concept: null })).toMatchObject({ outcome: "declined" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "hero_image", outcome: "declined" }]);
  });

  it("keeps an existing image on revision without a call (FR-7.9)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    const out = await runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 1, article, concept: "a concept", existingAssetRef: "image-old" }, "rev1");
    expect(out).toEqual({ outcome: "produced", assetRef: "image-old" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "hero_image", revisionNo: 1, assetRef: "image-old" }]);
  });

  it("SKIPS without a route and FAILS on a provider error — the draft continues either way (FR-15.13)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("image", () => {
      throw new NoRouteError("image");
    });
    expect(await runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 0, article, concept: "a concept" })).toMatchObject({ outcome: "skipped" });
    shared.ai.respondWith("image", () => {
      throw new Error("no gpu");
    });
    expect(await runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 1, article, concept: "a concept" }, "rev1")).toEqual({ outcome: "failed", reason: "no gpu" });
  });

  it("lets a GateError halt the step (FR-15.12a)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("image", () => {
      throw new GateError("ai_paused", "paused");
    });
    await expect(runStep(shared.step as never, ctx, heroImage, { draftId, revisionNo: 0, article, concept: "a concept" })).rejects.toThrow(GateError);
  });
});
