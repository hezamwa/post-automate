import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { draftRow, seedDraftRow, startRun } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// POST /drafts/:id/decision and GET /drafts/:id (design §7, spec §5): the live-instance
// path, the stale rules (revise/change_angle 409; approve/reject direct), seen_at.
beforeEach(resetShared);

async function pending(extra: Partial<typeof schema.drafts.$inferInsert> = {}) {
  const params = await startRun();
  const docId = `drafts.postauto-${params.runId}`;
  shared.sanity.docs.set(docId, { _id: docId, _type: "post" });
  const draftId = await seedDraftRow(params, { markdown: "# final", sanityDocumentId: docId, ...extra });
  return { params, draftId, token: await tokenFor(params.userId) };
}

describe("POST /drafts/:id/decision", () => {
  it("delivers the decision to the live instance, channels included (spec §4.1)", async () => {
    const { env, pipeline } = apiEnv();
    const { params, draftId, token } = await pending();
    await pipeline.binding.create({ id: params.runId });
    await shared.db.update(schema.pipelineRuns).set({ workflowInstanceId: params.runId }).where(eq(schema.pipelineRuns.id, params.runId));
    const res = await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "approve", publishMode: "now", channels: ["x"] } });
    expect(res).toMatchObject({ status: 200, json: { ok: true, via: "workflow" } });
    expect(pipeline.instances.get(params.runId)?.events).toEqual([{ type: "approval", payload: { action: "approve", publishMode: "now", channels: ["x"] } }]);
  });

  it("rejects a malformed payload with 400 (channels must be known kinds)", async () => {
    const { env } = apiEnv();
    const { draftId, token } = await pending();
    expect((await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "approve", channels: ["tiktok"] } })).status).toBe(400);
    expect((await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "timeout" } })).status).toBe(400);
  });

  it("stale: revise and change_angle are refused with a human-readable 409 (spec §5.1)", async () => {
    const { env } = apiEnv();
    const { draftId, token } = await pending({ stale: true });
    const res = await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "revise", instructions: "shorter" } });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/pipeline run has ended.*approve.*reject/);
    expect((await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "change_angle", angleIndex: 1 } })).status).toBe(409);
  });

  it("stale: approve runs derivatives and publishes directly, without touching the instance", async () => {
    const { env, pipeline } = apiEnv();
    const { params, draftId, token } = await pending({ stale: true });
    await pipeline.binding.create({ id: params.runId });
    await shared.db.update(schema.pipelineRuns).set({ workflowInstanceId: params.runId }).where(eq(schema.pipelineRuns.id, params.runId));
    const res = await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "approve", publishMode: "now" } });
    expect(res).toMatchObject({ status: 200, json: { ok: true, via: "direct", status: "published" } });
    expect(pipeline.instances.get(params.runId)?.events).toEqual([]);
    expect(await draftRow(params.runId)).toMatchObject({ status: "published" });
    expect(shared.ai.callsFor("shorten_x")).toHaveLength(1);
  });

  it("stale: reject goes direct too", async () => {
    const { env } = apiEnv();
    const { params, draftId, token } = await pending({ stale: true });
    const res = await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "reject", rejectionCategory: "quality" } });
    expect(res).toMatchObject({ status: 200, json: { via: "direct" } });
    expect(await draftRow(params.runId)).toMatchObject({ status: "rejected", markdown: null });
  });

  it("publishing.paused turns a direct approve into 503, draft untouched (FR-15.12b)", async () => {
    const { env } = apiEnv();
    const { params, draftId, token } = await pending({ stale: true });
    await shared.db.insert(schema.appConfig).values({ key: "publishing.paused", value: true });
    const res = await call(env, `/drafts/${draftId}/decision`, { method: "POST", token, body: { action: "approve", publishMode: "now" } });
    expect(res.status).toBe(503);
    expect(await draftRow(params.runId)).toMatchObject({ status: "pending_approval" });
  });

  it("a foreign draft reads as 404 (FR-2.3)", async () => {
    const { env } = apiEnv();
    const { draftId } = await pending();
    const other = await startRun();
    expect((await call(env, `/drafts/${draftId}/decision`, { method: "POST", token: await tokenFor(other.userId), body: { action: "reject" } })).status).toBe(404);
  });
});

describe("GET /drafts/:id", () => {
  it("records the first open by the owner as seen_at and keeps that timestamp afterwards (spec §5.2)", async () => {
    const { env } = apiEnv();
    const { params, draftId, token } = await pending();
    const first = await call(env, `/drafts/${draftId}`, { token });
    expect(first.status).toBe(200);
    expect((first.json.draft as { seenAt: unknown }).seenAt).toBeNull(); // this response is the first open
    const seenAt = (await draftRow(params.runId))?.seenAt;
    expect(seenAt).toBeInstanceOf(Date);
    await call(env, `/drafts/${draftId}`, { token });
    expect((await draftRow(params.runId))?.seenAt).toEqual(seenAt);
  });

  it("exposes stale and the approved channels for the review screen", async () => {
    const { env } = apiEnv();
    const { draftId, token } = await pending({ stale: true, channels: ["x"] });
    const res = await call(env, `/drafts/${draftId}`, { token });
    expect(res.json.draft).toMatchObject({ stale: true, channels: ["x"] });
  });
});

describe("POST /drafts/:id/hold and the gate info on GET /drafts/:id (spec §4.1, §4.3)", () => {
  it("hold answers the publish gate when the run is waiting there, 409 otherwise", async () => {
    const { env, pipeline } = apiEnv();
    const { params, draftId, token } = await pending();
    await pipeline.binding.create({ id: params.runId });
    await shared.db.update(schema.pipelineRuns).set({ workflowInstanceId: params.runId, gate: "publish" }).where(eq(schema.pipelineRuns.id, params.runId));
    expect((await call(env, `/drafts/${draftId}/hold`, { method: "POST", token })).status).toBe(200);
    expect(pipeline.instances.get(params.runId)?.events).toEqual([{ type: "gate-publish", payload: { optionId: "hold" } }]);
    await shared.db.update(schema.pipelineRuns).set({ gate: null }).where(eq(schema.pipelineRuns.id, params.runId));
    expect((await call(env, `/drafts/${draftId}/hold`, { method: "POST", token })).status).toBe(409);
  });

  it("the detail carries the derivatives gate (setting, options, pre-ticked) and the publish setting", async () => {
    const { env } = apiEnv();
    const { draftId, token } = await pending();
    const res = await call(env, `/drafts/${draftId}`, { token });
    expect(res.json.gates).toEqual({
      derivatives: { setting: "ask", options: [{ id: "x", title: "X post", summary: "", why: "" }, { id: "linkedin", title: "LinkedIn post", summary: "", why: "" }], preselected: ["x", "linkedin"] },
      publish: { setting: "auto" },
    });
  });
});

describe("POST /drafts/:id/hold — the auto-publish warning's Hold (spec §5.2)", () => {
  it("records the hold on a warned draft, so the job leaves it alone", async () => {
    const { env } = apiEnv();
    const { params, draftId, token } = await pending({ autoPublishWarnedAt: new Date() });
    const res = await call(env, `/drafts/${draftId}/hold`, { method: "POST", token });
    expect(res).toMatchObject({ status: 200, json: { ok: true, via: "auto-publish" } });
    expect((await draftRow(params.runId))?.autoPublishHeldAt).toBeInstanceOf(Date);
    const detail = await call(env, `/drafts/${draftId}`, { token });
    expect(detail.json).toMatchObject({ autoPublish: false, draft: { autoPublishHeldAt: expect.any(String) } });
  });
});
