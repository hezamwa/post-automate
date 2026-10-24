import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { qualityCheck } from "../../../src/workflows/steps/quality-check";
import { runStep } from "../../../src/workflows/steps/step";
import { techProfile } from "../../fixtures";
import { draftRow, seedDraftRow, stepContext } from "../harness";
import { article, OUTLINE, PASSING_FINDINGS } from "../mocks";

// quality-check (spec §3 step 8): one judge call merged with the deterministic checks;
// the verdict lands on the draft when there is one.
beforeEach(resetShared);

describe("quality-check step", () => {
  it("passes a good article with one call and every finding ok", async () => {
    const ctx = await stepContext();
    const out = await runStep(shared.step as never, ctx, qualityCheck, { article: article(), outline: OUTLINE });
    expect(out).toMatchObject({ passed: true, autoRevised: false });
    expect(out.findings.map((f) => f.check).sort()).toEqual(["banned_topics", "disclaimer", "language", "length", "medical_language", "outline", "similarity"]);
    expect(shared.step.billedTasks("quality-check")).toEqual(["quality_check"]);
    expect(shared.ai.callsFor("quality_check")[0]!.input.messages[0]!.content).toContain("APPROVED OUTLINE");
  });

  it("fails when the judge flags a check, and records the verdict on the draft", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("quality_check", () => ({ findings: PASSING_FINDINGS.map((f) => (f.check === "outline" ? { ...f, ok: false, note: "section 3 missing" } : f)) }));
    const out = await runStep(shared.step as never, ctx, qualityCheck, { article: article(), outline: OUTLINE, draftId });
    expect(out.passed).toBe(false);
    expect(out.findings.find((f) => f.check === "outline")).toMatchObject({ ok: false, note: "section 3 missing" });
    expect((await draftRow(ctx.runId))?.qualityCheck).toMatchObject({ passed: false });
  });

  it("the deterministic length check overrides a lenient judge", async () => {
    const ctx = await stepContext();
    const out = await runStep(shared.step as never, ctx, qualityCheck, { article: article("# tiny\n\nthree words only"), outline: null });
    expect(out.passed).toBe(false);
    expect(out.findings.find((f) => f.check === "length")).toMatchObject({ ok: false, note: expect.stringContaining("target of ~1200") });
  });

  it("a medical profile fails without the exact disclaimer block, deterministically (FR-6.6)", async () => {
    const medical = techProfile({
      domain: { field: "medical", subNiches: ["emergency medicine"] },
      compliance: { noDiagnosis: true, noDosage: true, noCaseReferences: true, disclaimerText: "This is general information, not medical advice." },
    });
    const ctx = await stepContext({ profile: medical });
    const without = await runStep(shared.step as never, ctx, qualityCheck, { article: article(), outline: null });
    expect(without.findings.find((f) => f.check === "disclaimer")).toMatchObject({ ok: false });
    const withIt = await runStep(shared.step as never, ctx, qualityCheck, { article: article(article().markdown + "\n\nThis is general information, not medical advice."), outline: null }, "2");
    expect(withIt.findings.find((f) => f.check === "disclaimer")).toMatchObject({ ok: true });
  });
});
