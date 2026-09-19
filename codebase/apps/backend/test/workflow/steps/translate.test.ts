import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { NoRouteError } from "../../../src/ai/router";
import { runStep } from "../../../src/workflows/steps/step";
import { translate } from "../../../src/workflows/steps/translate";
import { techProfile } from "../../fixtures";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// translate (spec §3 step 16, FR-6.14): one call from the final text; requested-but-failing is never silent.
beforeEach(resetShared);
const source = { title: "T", excerpt: "e", imageAlt: "alt", markdown: "# hello" };

describe("translate step", () => {
  it("is absent without a row when the profile has translation off", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toEqual({ outcome: "absent" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(draftId)).toEqual([]);
  });

  it("produces the edition with the second document's metadata when enabled (FR-3.13)", async () => {
    const ctx = await stepContext({ profile: techProfile({ translation: { enabled: true, targetLanguage: "ar" } }) });
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toEqual({ outcome: "produced" });
    expect(shared.step.billedTasks("translate")).toEqual(["translate"]);
    expect(await derivativeRows(draftId)).toMatchObject([
      { kind: "translation", outcome: "produced", content: "# مرحبا", meta: { title: "عنوان", excerpt: "ملخص", imageAlt: "وصف", targetLanguage: "ar" } },
    ]);
  });

  it("records a REQUESTED translation as failed with the reason when unroutable (FR-15.13)", async () => {
    const ctx = await stepContext({ profile: techProfile({ translation: { enabled: true, targetLanguage: "ar" } }) });
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("translate", () => {
      throw new NoRouteError("translate");
    });
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toMatchObject({ outcome: "failed", reason: expect.stringContaining("no enabled route") });
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "translation", outcome: "failed" }]);
  });
});
