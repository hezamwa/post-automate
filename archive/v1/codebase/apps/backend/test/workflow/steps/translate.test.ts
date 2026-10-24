import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { NoRouteError } from "../../../src/ai/router";
import { runStep } from "../../../src/workflows/steps/step";
import { translate } from "../../../src/workflows/steps/translate";
import { techProfile } from "../../fixtures";
import { derivativeRows, seedDraftRow, stepContext } from "../harness";

// translate (spec §3 step 16, FR-6.14): one call from the draft's FINAL markdown, after
// approval; requested-but-failing is never silent; unticked is declined.
beforeEach(resetShared);
const arabic = () => techProfile({ translation: { enabled: true, targetLanguage: "ar" } });
const source = { title: "T", excerpt: "e", imageAlt: "alt" };

describe("translate step", () => {
  it("is absent without a row when the profile has translation off", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toEqual({ outcome: "absent" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(draftId)).toEqual([]);
  });

  it("produces the edition from the draft markdown with the second document's metadata (FR-3.13)", async () => {
    const ctx = await stepContext({ profile: arabic() });
    const draftId = await seedDraftRow(ctx, { markdown: "# final text" });
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toEqual({ outcome: "produced" });
    expect(shared.step.billedTasks("translate")).toEqual(["translate"]);
    expect(shared.ai.callsFor("translate")[0]!.input.messages[0]!.content).toContain("# final text");
    expect(await derivativeRows(draftId)).toMatchObject([
      { kind: "translation", outcome: "produced", content: "# مرحبا", meta: { title: "عنوان", excerpt: "ملخص", imageAlt: "وصف", targetLanguage: "ar" } },
    ]);
  });

  it("is DECLINED — a row, no call — when unticked at approval (spec §7)", async () => {
    const ctx = await stepContext({ profile: arabic() });
    const draftId = await seedDraftRow(ctx, { channels: ["x", "linkedin"] });
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0 })).toEqual({ outcome: "declined" });
    expect(shared.step.bills).toEqual([]);
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "translation", outcome: "declined" }]);
  });

  it("records a REQUESTED translation as failed with the reason when unroutable (FR-15.13)", async () => {
    const ctx = await stepContext({ profile: arabic() });
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("translate", () => {
      throw new NoRouteError("translate");
    });
    expect(await runStep(shared.step as never, ctx, translate, { draftId, revisionNo: 0, source })).toMatchObject({ outcome: "failed", reason: expect.stringContaining("no enabled route") });
    expect(await derivativeRows(draftId)).toMatchObject([{ kind: "translation", outcome: "failed" }]);
  });
});
