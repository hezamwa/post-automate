import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { seedCreator, seedDraftRow, startRun } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// POST /runs/trigger and /runs/request (spec §2): the Generate button refuses while a
// draft is undecided — 409 with the draft id so the app opens it instead. Any
// authenticated request refreshes users.last_active_at.
beforeEach(resetShared);

describe("POST /runs/trigger", () => {
  it("launches a run and records the instance id", async () => {
    const { env, pipeline } = apiEnv();
    const userId = await seedCreator();
    const res = await call(env, "/runs/trigger", { method: "POST", token: await tokenFor(userId) });
    expect(res.status).toBe(200);
    expect(pipeline.instances.has(res.json.runId as string)).toBe(true);
    const run = await shared.db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, res.json.runId as string) });
    expect(run).toMatchObject({ trigger: "manual", workflowInstanceId: res.json.runId });
  });

  it("returns 409 with the existing draft id while one is undecided — no run, no spend (FR-7.4)", async () => {
    const { env, pipeline } = apiEnv();
    const params = await startRun();
    const draftId = await seedDraftRow(params, { status: "revising" });
    const res = await call(env, "/runs/trigger", { method: "POST", token: await tokenFor(params.userId) });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ existingDraftId: draftId, error: expect.stringContaining("already waiting") });
    expect(pipeline.instances.size).toBe(0);
    // the same rule guards user-topic runs
    const req = await call(env, "/runs/request", { method: "POST", token: await tokenFor(params.userId), body: { title: "mine" } });
    expect(req.status).toBe(409);
    expect(req.json.existingDraftId).toBe(draftId);
  });

  it("does not count decided drafts", async () => {
    const { env } = apiEnv();
    const params = await startRun();
    await seedDraftRow(params, { status: "published", markdown: null });
    expect((await call(env, "/runs/trigger", { method: "POST", token: await tokenFor(params.userId) })).status).toBe(200);
  });
});

describe("activity (spec §2)", () => {
  it("any authenticated request stamps users.last_active_at", async () => {
    const { env } = apiEnv();
    const userId = await seedCreator();
    expect((await shared.db.query.users.findFirst({ where: eq(schema.users.id, userId) }))?.lastActiveAt).toBeNull();
    await call(env, "/drafts", { token: await tokenFor(userId) });
    expect((await shared.db.query.users.findFirst({ where: eq(schema.users.id, userId) }))?.lastActiveAt).toBeInstanceOf(Date);
  });

  it("an unauthenticated request stamps nothing and gets 401", async () => {
    const { env } = apiEnv();
    const userId = await seedCreator();
    expect((await call(env, "/drafts")).status).toBe(401);
    expect((await shared.db.query.users.findFirst({ where: eq(schema.users.id, userId) }))?.lastActiveAt).toBeNull();
  });
});
