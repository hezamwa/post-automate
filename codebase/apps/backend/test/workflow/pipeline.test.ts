import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "./preamble";
import { seedDraft, seedSpend } from "../db/harness";
import { candidateRows, derivativeRows, draftRow, revisionRows, runRow, runWorkflow, startRun } from "./harness";
import { article } from "./mocks";

// The v1 article flow, end to end through the new structure (spec §1 order): every path
// the old bundled pipeline supported, driven by scripted decisions against real Postgres.
// Every scenario also asserts the spec §3 invariant — one billable call per step attempt —
// with the two temporary v1 bundles named explicitly until their split lands.

const V1_BUNDLED_STEPS = ["derivatives"];

beforeEach(resetShared);

const approve = (extra: Record<string, unknown> = {}) => ({ type: "approval", payload: { action: "approve", publishMode: "now", ...extra } });

describe("scheduled/manual run", () => {
  it("discover → score → angles → draft → derivatives → Sanity draft → notify → approve → published", async () => {
    const params = await startRun();
    shared.step.script(approve());
    await runWorkflow(params);

    expect(shared.step.executed).toEqual([
      "gates", "load-profile", "discover", "score", "angles", "draft", "derivatives", "save-draft",
      "create-sanity-draft", "record-derivatives", "notify", "gate-draft", "publish",
    ]);
    expect((await runRow(params.runId))).toMatchObject({ state: "published", angleProposals: { recommendedIndex: 1 } });
    const draft = await draftRow(params.runId);
    expect(draft).toMatchObject({ status: "published", markdown: null, sanityDocumentId: `postauto-${params.runId}` });
    expect(draft?.angle).toMatchObject({ headline: "Angle one" }); // the recommendation, no user pick
    expect(shared.sanity.docs.has(`postauto-${params.runId}`)).toBe(true);
    expect(shared.sanity.docs.has(`drafts.postauto-${params.runId}`)).toBe(false);
    const candidates = await candidateRows(params.runId);
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((c) => c.selected).map((c) => c.title)).toEqual(["Agents in production"]);
    const derivatives = await derivativeRows(draft!.id);
    expect(derivatives.map((d) => [d.kind, d.outcome]).sort()).toEqual([["hero_image", "produced"], ["linkedin", "produced"], ["x", "produced"]]);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Draft ready for review"]);
    expect(shared.step.billingViolations(V1_BUNDLED_STEPS)).toEqual([]);
  });

  it("approve for the next slot schedules the draft for the hourly publisher", async () => {
    const params = await startRun();
    shared.step.script(approve({ publishMode: "next_slot" }));
    await runWorkflow(params);
    expect((await runRow(params.runId))?.state).toBe("publishing");
    const draft = await draftRow(params.runId);
    expect(draft?.status).toBe("scheduled");
    expect(draft?.publishAt).toBeInstanceOf(Date);
    expect(shared.sanity.docs.has(`postauto-${params.runId}`)).toBe(false);
  });

  it("approve with edits stores the diff, patches Sanity and keeps the blogType", async () => {
    const params = await startRun();
    shared.step.script(approve({ editedMarkdown: "# Edited by hand", blogType: "em" }));
    await runWorkflow(params);
    const draft = await draftRow(params.runId);
    expect(draft).toMatchObject({ status: "published", blogType: "em" });
    const diffs = await shared.db.query.editDiffs.findMany();
    expect(diffs).toHaveLength(1);
    expect(JSON.parse(diffs[0]!.diff)).toMatchObject({ after: "# Edited by hand" });
    const published = shared.sanity.docs.get(`postauto-${params.runId}`) as { content: unknown[] };
    expect(JSON.stringify(published.content)).toContain("Edited by hand");
  });

  it("nothing scores ≥ 6 → run skipped before any angle is proposed", async () => {
    const params = await startRun();
    shared.ai.respondWith("scoring", () => ({ scores: [{ index: 0, score: 3, reason: "weak" }] }));
    await runWorkflow(params);
    expect(shared.step.executed).toEqual(["gates", "load-profile", "discover", "score", "record-no-topic"]);
    expect(await runRow(params.runId)).toMatchObject({ state: "skipped", error: expect.stringContaining("no candidate scored") });
    expect(shared.ai.callsFor("angles")).toHaveLength(0);
  });

  it("two pending drafts → skipped at the gates with a reminder push and zero spend (FR-7.4)", async () => {
    const params = await startRun();
    await seedDraft(shared.db, params.userId, params.runId, "pending_approval");
    await seedDraft(shared.db, params.userId, params.runId, "revising");
    await runWorkflow(params);
    expect(shared.step.executed).toEqual(["gates", "record-skip"]);
    expect((await runRow(params.runId))?.state).toBe("skipped");
    expect(shared.pushes.map((p) => p.title)).toEqual(["Drafts waiting for your review"]);
    expect(shared.ai.calls).toHaveLength(0);
  });

  it("a budget cap refuses the run as failed, with the reason recorded and pushed (design §5)", async () => {
    const params = await startRun();
    await seedSpend(shared.db, params.userId, 10);
    await expect(runWorkflow(params)).rejects.toThrow(/Monthly AI budget/);
    expect(await runRow(params.runId)).toMatchObject({ state: "failed", error: expect.stringContaining("Monthly AI budget") });
    expect(shared.step.attempts.get("gates")).toBe(1); // a decision, not retried
    expect(shared.pushes.map((p) => p.title)).toEqual(["Pipeline run failed"]);
  });
});

describe("user-topic run", () => {
  const userTopic = { title: "My own topic", notes: "keep it short", links: ["https://x.example"] };

  it("researches instead of discovering and waits for the requester's angle pick (FR-5.8, FR-6.3)", async () => {
    const params = await startRun({ userTopic });
    shared.step.script({ type: "angle-choice", payload: { angleIndex: 0 } }, approve());
    await runWorkflow(params);
    expect(shared.step.executed.slice(0, 4)).toEqual(["gates", "load-profile", "research", "angles"]);
    expect(shared.step.waits[0]).toMatchObject({ type: "angle-choice", outcome: "answered" });
    expect((await draftRow(params.runId))?.angle).toMatchObject({ headline: "Angle zero" });
    const candidates = await candidateRows(params.runId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "user", selected: true });
    expect(shared.step.billingViolations(V1_BUNDLED_STEPS)).toEqual([]);
  });

  it("auto-picks the recommended angle when the requester never answers (v1: 24h timeout)", async () => {
    const params = await startRun({ userTopic });
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.waits[0]).toMatchObject({ type: "angle-choice", outcome: "timeout" });
    expect((await draftRow(params.runId))?.angle).toMatchObject({ headline: "Angle one" });
  });
});

describe("the review loop (FR-7.9)", () => {
  it("revise ×3 re-drafts with the instructions, keeps the hero image, then publishes", async () => {
    const params = await startRun();
    shared.step.script(
      { type: "approval", payload: { action: "revise", instructions: "make it shorter" } },
      { type: "approval", payload: { action: "revise", instructions: "add a takeaway" } },
      { type: "approval", payload: { action: "revise", instructions: "fix the hook" } },
      approve(),
    );
    await runWorkflow(params);
    expect(shared.step.executed).toEqual(expect.arrayContaining(["draft-rev1", "derivatives-rev1", "create-sanity-draft-rev1", "record-derivatives-rev1", "notify-rev1", "draft-rev3", "publish"]));
    const draft = await draftRow(params.runId);
    expect(draft?.status).toBe("published");
    expect((await revisionRows(draft!.id)).map((r) => [r.revisionNo, r.instructions])).toEqual([[1, "make it shorter"], [2, "add a takeaway"], [3, "fix the hook"]]);
    expect(shared.ai.callsFor("article")).toHaveLength(4);
    expect(shared.ai.callsFor("article")[1]!.input.messages[0]!.content).toContain("make it shorter");
    expect(shared.ai.callsFor("image")).toHaveLength(1); // image kept across revisions
    expect((await derivativeRows(draft!.id)).filter((d) => d.kind === "x").map((d) => d.revisionNo).sort()).toEqual([0, 1, 2, 3]);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Draft ready for review", "Revised draft ready for review", "Revised draft ready for review", "Revised draft ready for review"]);
    expect(shared.step.billingViolations(V1_BUNDLED_STEPS)).toEqual([]);
  });

  it("a fourth revise is ignored — the loop keeps waiting for a terminal decision", async () => {
    const params = await startRun();
    const revise = { type: "approval", payload: { action: "revise", instructions: "again" } };
    shared.step.script(revise, revise, revise, revise, approve());
    await runWorkflow(params);
    const draft = await draftRow(params.runId);
    expect(draft?.status).toBe("published");
    expect(await revisionRows(draft!.id)).toHaveLength(3);
    expect(shared.ai.callsFor("article")).toHaveLength(4);
  });

  it("change_angle re-drafts from another stored angle without an instructions row", async () => {
    const params = await startRun();
    shared.step.script({ type: "approval", payload: { action: "change_angle", angleIndex: 2 } }, approve());
    await runWorkflow(params);
    expect(shared.ai.callsFor("article")).toHaveLength(2);
    expect(shared.ai.callsFor("article")[1]!.input.messages[0]!.content).toContain("Angle two");
    const draft = await draftRow(params.runId);
    expect(await revisionRows(draft!.id)).toHaveLength(0);
    expect(draft?.status).toBe("published");
  });

  it("reject deletes the Sanity draft, purges the markdown and closes the run (FR-7.8)", async () => {
    const params = await startRun();
    shared.step.script({ type: "approval", payload: { action: "reject", rejectionCategory: "quality" } });
    await runWorkflow(params);
    expect(await runRow(params.runId)).toMatchObject({ state: "rejected", error: "rejected: quality" });
    expect(await draftRow(params.runId)).toMatchObject({ status: "rejected", rejectionCategory: "quality", markdown: null });
    expect(shared.sanity.docs.size).toBe(0);
  });

  it("no decision within the wait → expired (v1 semantics), Sanity draft kept for manual handling", async () => {
    const params = await startRun();
    await runWorkflow(params);
    expect(await runRow(params.runId)).toMatchObject({ state: "expired" });
    expect(await draftRow(params.runId)).toMatchObject({ status: "expired", markdown: null });
    expect(shared.sanity.docs.has(`drafts.postauto-${params.runId}`)).toBe(true);
  });
});

describe("retry boundaries", () => {
  it("CANNOT_COMPLY fails the run once, without retrying the article call (FR-6.6–6.8)", async () => {
    const params = await startRun();
    shared.ai.respondWith("article", () => article("CANNOT_COMPLY"));
    await expect(runWorkflow(params)).rejects.toThrow(/CANNOT_COMPLY/);
    expect(shared.step.attempts.get("draft")).toBe(1);
    expect(shared.ai.callsFor("article")).toHaveLength(1);
    expect(await runRow(params.runId)).toMatchObject({ state: "failed", error: expect.stringContaining("CANNOT_COMPLY") });
    expect(shared.pushes.map((p) => p.title)).toEqual(["Pipeline run failed"]);
    expect(shared.step.executed).not.toContain("derivatives");
  });

  it("a transient provider error is retried at the step boundary and the run completes", async () => {
    const params = await startRun();
    let calls = 0;
    shared.ai.respondWith("article", () => {
      if (calls++ === 0) throw new Error("provider down");
      return article();
    });
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.attempts.get("draft")).toBe(2);
    expect((await runRow(params.runId))?.state).toBe("published");
    expect(shared.step.billingViolations(V1_BUNDLED_STEPS)).toEqual([]); // one call per ATTEMPT
  });
});
