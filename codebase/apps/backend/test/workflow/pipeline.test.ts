import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "./preamble";
import { seedDraft, seedSpend } from "../db/harness";
import { techProfile } from "../fixtures";
import { candidateRows, derivativeRows, draftRow, revisionRows, runRow, runWorkflow, seedSearchRoute, startRun } from "./harness";
import { article } from "./mocks";

// The article flow end to end through the new structure (spec §1 order): every path the
// pipeline supports, driven by scripted decisions against real Postgres. Every scenario
// also asserts the spec §3 invariant — one billable call per step attempt.

beforeEach(resetShared);

const approve = (extra: Record<string, unknown> = {}) => ({ type: "approval", payload: { action: "approve", publishMode: "now", ...extra } });
const PRE_REVIEW = ["gates", "load-profile", "search", "synthesize-candidates", "score", "angles", "draft", "save-draft", "derive-x", "derive-linkedin", "translate", "hero-image", "write-sanity-draft", "notify"];

describe("scheduled/manual run", () => {
  it("search → synthesize → score → angles → draft → save → derivatives → hero → Sanity → notify → approve → published", async () => {
    const params = await startRun();
    shared.step.script(approve());
    await runWorkflow(params);

    expect(shared.step.executed).toEqual([...PRE_REVIEW, "gate-draft", "publish"]);
    expect(await runRow(params.runId)).toMatchObject({ state: "published", angleProposals: { recommendedIndex: 1 } });
    const draft = await draftRow(params.runId);
    expect(draft).toMatchObject({ status: "published", markdown: null, sanityDocumentId: `postauto-${params.runId}` });
    expect(draft?.angle).toMatchObject({ headline: "Angle one" }); // the recommendation, no user pick
    expect(shared.sanity.docs.get(`postauto-${params.runId}`)).toMatchObject({ xVersion: "short post", linkedinVersion: "short post", image: { asset: { _ref: "image-fake-asset" } } });
    expect(shared.sanity.docs.has(`drafts.postauto-${params.runId}`)).toBe(false);
    const candidates = await candidateRows(params.runId);
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((c) => c.selected).map((c) => c.title)).toEqual(["Agents in production"]);
    const derivatives = await derivativeRows(draft!.id);
    expect(derivatives.map((d) => [d.kind, d.outcome]).sort()).toEqual([["hero_image", "produced"], ["linkedin", "produced"], ["x", "produced"]]);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Draft ready for review"]);
    expect(shared.step.billingViolations()).toEqual([]);
  });

  it("with no web_search route the search step bills nothing and the model searches for itself", async () => {
    const params = await startRun();
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.billedTasks("search")).toEqual([]);
    expect(shared.ai.callsFor("discovery")[0]!.input.webSearch).toBe(true);
  });

  it("with a web_search route the snippets are fetched once and handed to the synthesis call (FR-5.4)", async () => {
    const params = await startRun();
    await seedSearchRoute();
    shared.ai.respondWith("web_search", () => [{ title: "Fetched headline", url: "https://found.example", snippet: "a real snippet" }]);
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.billedTasks("search")).toEqual(["web_search"]);
    const synth = shared.ai.callsFor("discovery")[0]!.input;
    expect(synth.webSearch).toBe(false);
    expect(synth.messages[0]!.content).toContain("Fetched headline");
    expect(shared.step.billingViolations()).toEqual([]);
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

  it("a translation-enabled profile gets the second edition from one translate call (FR-3.13)", async () => {
    const params = await startRun({ profile: techProfile({ translation: { enabled: true, targetLanguage: "ar" } }) });
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.billedTasks("translate")).toEqual(["translate"]);
    const draft = await draftRow(params.runId);
    expect((await derivativeRows(draft!.id)).find((d) => d.kind === "translation")).toMatchObject({
      outcome: "produced",
      content: "# مرحبا",
      meta: { targetLanguage: "ar", title: "عنوان" },
    });
    expect(shared.sanity.docs.has(`postauto-${params.runId}-ar`)).toBe(true); // translated edition published too
  });

  it("an over-limit X version gets ONE corrective pass as its own step (spec §3)", async () => {
    const params = await startRun();
    let n = 0;
    shared.ai.respondWith("shorten_x", () => (n++ === 0 ? "x".repeat(300) : "tight post"));
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.step.executed).toContain("derive-x-shorten");
    expect(shared.step.billedTasks("derive-x")).toEqual(["shorten_x"]);
    expect(shared.step.billedTasks("derive-x-shorten")).toEqual(["shorten_x"]);
    const draft = await draftRow(params.runId);
    expect((await derivativeRows(draft!.id)).find((d) => d.kind === "x")?.content).toBe("tight post");
    expect(shared.step.billingViolations()).toEqual([]);
  });

  it("nothing scores ≥ 6 → run skipped before any angle is proposed", async () => {
    const params = await startRun();
    shared.ai.respondWith("scoring", () => ({ scores: [{ index: 0, score: 3, reason: "weak" }] }));
    await runWorkflow(params);
    expect(shared.step.executed).toEqual(["gates", "load-profile", "search", "synthesize-candidates", "score", "record-no-topic"]);
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

  it("searches the topic, researches it and waits for the requester's angle pick (FR-5.8, FR-6.3)", async () => {
    const params = await startRun({ userTopic });
    await seedSearchRoute();
    shared.ai.respondWith("web_search", () => [{ title: "Primary source", url: "https://src.example", snippet: "…" }]);
    shared.step.script({ type: "angle-choice", payload: { angleIndex: 0 } }, approve());
    await runWorkflow(params);
    expect(shared.step.executed.slice(0, 5)).toEqual(["gates", "load-profile", "search", "research", "angles"]);
    expect(shared.ai.callsFor("web_search")[0]!.input.messages[0]!.content).toBe("My own topic");
    expect(shared.ai.callsFor("research")[0]!.input.messages[0]!.content).toContain("Primary source");
    expect(shared.step.waits[0]).toMatchObject({ type: "angle-choice", outcome: "answered" });
    expect((await draftRow(params.runId))?.angle).toMatchObject({ headline: "Angle zero" });
    const candidates = await candidateRows(params.runId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "user", selected: true });
    expect(shared.step.billingViolations()).toEqual([]);
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
    expect(shared.step.executed).toEqual(expect.arrayContaining(["draft-rev1", "derive-x-rev1", "derive-linkedin-rev1", "translate-rev1", "hero-image-rev1", "write-sanity-draft-rev1", "notify-rev1", "draft-rev3", "publish"]));
    const draft = await draftRow(params.runId);
    expect(draft?.status).toBe("published");
    expect((await revisionRows(draft!.id)).map((r) => [r.revisionNo, r.instructions])).toEqual([[1, "make it shorter"], [2, "add a takeaway"], [3, "fix the hook"]]);
    expect(shared.ai.callsFor("article")).toHaveLength(4);
    expect(shared.ai.callsFor("article")[1]!.input.messages[0]!.content).toContain("make it shorter");
    expect(shared.ai.callsFor("image")).toHaveLength(1); // image kept across revisions
    const derivatives = await derivativeRows(draft!.id);
    expect(derivatives.filter((d) => d.kind === "x").map((d) => d.revisionNo).sort()).toEqual([0, 1, 2, 3]);
    expect(derivatives.filter((d) => d.kind === "hero_image").every((d) => d.assetRef === "image-fake-asset")).toBe(true);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Draft ready for review", "Revised draft ready for review", "Revised draft ready for review", "Revised draft ready for review"]);
    expect(shared.step.billingViolations()).toEqual([]);
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
    expect(shared.step.executed).not.toContain("derive-x");
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
    expect(shared.step.billingViolations()).toEqual([]); // one call per ATTEMPT
  });

  it("a failed translation never touches the X and LinkedIn calls (FR-15.13)", async () => {
    const params = await startRun({ profile: techProfile({ translation: { enabled: true, targetLanguage: "ar" } }) });
    shared.ai.respondWith("translate", () => {
      throw new Error("translator exploded");
    });
    shared.step.script(approve());
    await runWorkflow(params);
    expect(shared.ai.callsFor("shorten_x")).toHaveLength(1);
    expect(shared.ai.callsFor("shorten_linkedin")).toHaveLength(1);
    const draft = await draftRow(params.runId);
    expect((await derivativeRows(draft!.id)).find((d) => d.kind === "translation")).toMatchObject({ outcome: "failed", reason: "translator exploded" });
    expect(draft?.status).toBe("published"); // the article publishes alone
  });
});
