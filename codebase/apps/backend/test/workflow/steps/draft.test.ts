import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { ComplianceRefusalError } from "../../../src/modules/generation";
import { draft } from "../../../src/workflows/steps/draft";
import { runStep } from "../../../src/workflows/steps/step";
import { draftRow, revisionRows, seedCandidates, seedDraftRow, stepContext } from "../harness";
import { ANGLES, CANDIDATES, article } from "../mocks";

// draft (spec §3 step 7): one article call; CANNOT_COMPLY is a decision, not a failure.
beforeEach(resetShared);

async function topicFor(ctx: Awaited<ReturnType<typeof stepContext>>) {
  const [topic] = await seedCandidates(ctx, CANDIDATES.slice(0, 1));
  return topic!;
}

describe("draft step", () => {
  it("bills one article call from the topic brief and the chosen angle", async () => {
    const ctx = await stepContext();
    const out = await runStep(shared.step as never, ctx, draft, { topic: await topicFor(ctx), angle: ANGLES[2]!, outline: null });
    expect(shared.step.billedTasks("draft")).toEqual(["article"]);
    expect(out).toMatchObject({ article: article(), provider: "anthropic", model: "claude-sonnet-5" });
    expect(shared.ai.callsFor("article")[0]!.input.messages[0]!.content).toContain("Headline: Angle two");
  });

  it("carries the run's mood into the article prompt (FR-6.19)", async () => {
    const ctx = await stepContext();
    ctx.mood = "disappointed";
    await runStep(shared.step as never, ctx, draft, { topic: await topicFor(ctx), angle: ANGLES[0]!, outline: null });
    expect(JSON.stringify(shared.ai.callsFor("article")[0]!.input.system)).toContain("lean disappointed");
  });

  it("CANNOT_COMPLY is listed non-retryable and thrown once (FR-6.6–6.8)", async () => {
    const ctx = await stepContext();
    shared.ai.respondWith("article", () => article("CANNOT_COMPLY"));
    expect(draft.nonRetryable).toContain(ComplianceRefusalError);
    await expect(runStep(shared.step as never, ctx, draft, { topic: await topicFor(ctx), angle: ANGLES[0]!, outline: null })).rejects.toThrow(NonRetryableError);
    expect(shared.step.attempts.get("draft")).toBe(1);
  });

  it("a revise revision marks the draft revising, sends the current text + instructions, and records them (FR-7.9)", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx, { markdown: "# Old" });
    await runStep(shared.step as never, ctx, draft, {
      topic: await topicFor(ctx),
      angle: ANGLES[0]!,
      outline: null,
      revision: { draftId, revisionNo: 1, instructions: "tighter", currentMarkdown: "# Old" },
    }, "rev1");
    const prompt = shared.ai.callsFor("article")[0]!.input.messages[0]!.content;
    expect(prompt).toContain("# Old");
    expect(prompt).toContain("tighter");
    expect((await draftRow(ctx.runId))?.status).toBe("revising");
    expect(await revisionRows(draftId)).toMatchObject([{ revisionNo: 1, instructions: "tighter" }]);
  });

  it("a change_angle revision writes fresh from the new angle with no instructions row", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    await runStep(shared.step as never, ctx, draft, { topic: await topicFor(ctx), angle: ANGLES[1]!, outline: null, revision: { draftId, revisionNo: 1 } }, "rev1");
    expect(shared.ai.callsFor("article")[0]!.input.messages[0]!.content).toContain("Headline: Angle one");
    expect(await revisionRows(draftId)).toHaveLength(0);
  });
});
