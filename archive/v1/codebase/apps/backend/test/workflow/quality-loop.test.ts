import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "./preamble";
import { draftWithQualityCheck } from "../../src/workflows/loops/quality";
import { draftRow, seedCandidates, seedDraftRow, stepContext } from "./harness";
import { ANGLES, article, CANDIDATES, OUTLINE, PASSING_FINDINGS } from "./mocks";

// Spec §3 step 8: fail → ONE automatic revise with the findings, check again, proceed
// regardless with the findings attached. Creator revisions re-check without the auto revise.
beforeEach(resetShared);

const failing = () => ({ findings: PASSING_FINDINGS.map((f) => (f.check === "banned_topics" ? { ...f, ok: false, note: "mentions politics" } : f)) });

describe("draftWithQualityCheck", () => {
  it("a passing article costs one draft and one check", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    const { quality } = await draftWithQualityCheck(shared.step as never, ctx, { topic: topic!, angle: ANGLES[0]!, outline: OUTLINE, autoRevise: true });
    expect(quality).toMatchObject({ passed: true, autoRevised: false });
    expect(shared.step.executed).toEqual(["draft", "quality-check"]);
  });

  it("a failing check triggers exactly one revise with the findings, then re-checks and proceeds regardless", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    shared.ai.respondWith("quality_check", failing);
    let drafts = 0;
    shared.ai.respondWith("article", () => article(drafts++ === 0 ? article().markdown : article().markdown + "\n\nRevised."));
    const { drafted, quality } = await draftWithQualityCheck(shared.step as never, ctx, { topic: topic!, angle: ANGLES[0]!, outline: OUTLINE, autoRevise: true });
    expect(shared.step.executed).toEqual(["draft", "quality-check", "draft-qc", "quality-check-qc"]);
    expect(shared.ai.callsFor("article")[1]!.input.messages[0]!.content).toContain("banned_topics: mentions politics");
    expect(drafted.article.markdown).toContain("Revised.");
    expect(quality).toMatchObject({ passed: false, autoRevised: true }); // failed twice — the human is the final check (§7)
    expect(shared.step.billingViolations()).toEqual([]);
  });

  it("a creator revision re-checks without the automatic revise and keeps the verdict on the draft", async () => {
    const ctx = await stepContext();
    const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
    const draftId = await seedDraftRow(ctx);
    shared.ai.respondWith("quality_check", failing);
    await draftWithQualityCheck(shared.step as never, ctx, {
      topic: topic!, angle: ANGLES[0]!, outline: OUTLINE, autoRevise: false,
      revision: { draftId, revisionNo: 1, instructions: "shorter", currentMarkdown: "# old" },
    }, "rev1");
    expect(shared.step.executed).toEqual(["draft-rev1", "quality-check-rev1"]);
    expect((await draftRow(ctx.runId))?.qualityCheck).toMatchObject({ passed: false });
  });
});
