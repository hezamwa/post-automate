import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { recordGateChoice, setRunAngleProposals, setRunGate } from "../../src/db/commands";
import { seedCandidates, startRun } from "../workflow/harness";
import { ANGLES, CANDIDATES } from "../workflow/mocks";
import { apiEnv, call, tokenFor } from "./client";

// GET /runs/:id and POST /runs/:id/gates/:gate (spec §4, brief §6): one payload renders
// any gate; an answer is validated against the gate's choice schema and delivered to
// the live instance; 409 when the run is not waiting on that gate.
beforeEach(resetShared);

async function waitingOnTopic() {
  const { env, pipeline } = apiEnv();
  const params = await startRun();
  const refs = await seedCandidates(params, CANDIDATES);
  await shared.db.update(schema.topicCandidates).set({ score: "8", rejectionReason: "fits", selected: true }).where(eq(schema.topicCandidates.id, refs[0]!.id));
  await pipeline.binding.create({ id: params.runId });
  await shared.db.update(schema.pipelineRuns).set({ workflowInstanceId: params.runId, state: "scoring" }).where(eq(schema.pipelineRuns.id, params.runId));
  await setRunGate(shared.db, params.runId, "topic");
  return { env, pipeline, params, refs, token: await tokenFor(params.userId) };
}

describe("GET /runs/:id", () => {
  it("returns state, the waiting gate with its options, and the choices so far", async () => {
    const { env, params, refs, token } = await waitingOnTopic();
    await recordGateChoice(shared.db, { runId: params.runId, userId: params.userId, gate: "angle", optionsShown: {}, choice: { optionId: "1" }, source: "auto" });
    const res = await call(env, `/runs/${params.runId}`, { token });
    expect(res.status).toBe(200);
    expect(res.json.run).toMatchObject({ id: params.runId, state: "scoring", gate: "topic" });
    expect(res.json.run).not.toHaveProperty("workflowInstanceId");
    expect(res.json.draftId).toBeNull(); // no draft saved yet at the topic gate
    const gate = res.json.gate as { name: string; options: Array<{ id: string }>; recommended: string };
    expect(gate.name).toBe("topic");
    expect(gate.options).toHaveLength(3);
    expect(gate.recommended).toBe(refs[0]!.id);
    expect(res.json.choices).toMatchObject([{ gate: "angle", choice: { optionId: "1" }, source: "auto" }]);
  });

  it("gate is null when the run is not waiting; a foreign run is 404", async () => {
    const { env, params, token } = await waitingOnTopic();
    await setRunGate(shared.db, params.runId, null);
    expect((await call(env, `/runs/${params.runId}`, { token })).json.gate).toBeNull();
    const other = await startRun();
    expect((await call(env, `/runs/${params.runId}`, { token: await tokenFor(other.userId) })).status).toBe(404);
  });
});

describe("POST /runs/:id/gates/:gate", () => {
  it("delivers a valid answer to the live instance as a gate-<name> event", async () => {
    const { env, pipeline, params, refs, token } = await waitingOnTopic();
    const res = await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { optionId: refs[1]!.id } });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
    expect(pipeline.instances.get(params.runId)?.events).toEqual([{ type: "gate-topic", payload: { optionId: refs[1]!.id } }]);
  });

  it("accepts free text, and rejects an answer that fits neither shape (400)", async () => {
    const { env, params, token } = await waitingOnTopic();
    expect((await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { freeText: "something else entirely" } })).status).toBe(200);
    expect((await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { optionId: "nope" } })).status).toBe(400);
    expect((await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { optionId: "x", freeText: "y" } })).status).toBe(400);
  });

  it("409 when the run is waiting on a different gate, or on none; 404 for an unknown gate", async () => {
    const { env, params, token } = await waitingOnTopic();
    const wrong = await call(env, `/runs/${params.runId}/gates/angle`, { method: "POST", token, body: { optionId: "1" } });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toMatch(/waiting on the topic gate/);
    await setRunGate(shared.db, params.runId, null);
    expect((await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { freeText: "later" } })).status).toBe(409);
    expect((await call(env, `/runs/${params.runId}/gates/derivatives`, { method: "POST", token, body: {} })).status).toBe(404); // answered on the approve payload, never here
  });

  it("409 when the instance is gone (abandoned)", async () => {
    const { env, params, token } = await waitingOnTopic();
    await shared.db.update(schema.pipelineRuns).set({ workflowInstanceId: "gone" }).where(eq(schema.pipelineRuns.id, params.runId));
    const res = await call(env, `/runs/${params.runId}/gates/topic`, { method: "POST", token, body: { freeText: "too late" } });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/not reachable/);
  });

  it("the legacy /angle route answers the angle gate", async () => {
    const { env, pipeline, params, token } = await waitingOnTopic();
    await setRunAngleProposals(shared.db, params.runId, { angles: ANGLES, recommendedIndex: 1 });
    await setRunGate(shared.db, params.runId, "angle");
    expect((await call(env, `/runs/${params.runId}/angle`, { method: "POST", token, body: { angleIndex: 2 } })).status).toBe(200);
    expect(pipeline.instances.get(params.runId)?.events).toEqual([{ type: "gate-angle", payload: { optionId: "2" } }]);
  });
});

describe("POST /runs/:id/gates/outline", () => {
  it("accepts approve, edited sections, or free text", async () => {
    const { env, pipeline, params, token } = await waitingOnTopic();
    await setRunGate(shared.db, params.runId, "outline");
    expect((await call(env, `/runs/${params.runId}/gates/outline`, { method: "POST", token, body: { optionId: "approve" } })).status).toBe(200);
    expect((await call(env, `/runs/${params.runId}/gates/outline`, { method: "POST", token, body: { sections: [{ heading: "A", keyPoints: [] }, { heading: "B", keyPoints: ["x"] }] } })).status).toBe(200);
    expect((await call(env, `/runs/${params.runId}/gates/outline`, { method: "POST", token, body: { freeText: "another angle on it" } })).status).toBe(200);
    expect((await call(env, `/runs/${params.runId}/gates/outline`, { method: "POST", token, body: { optionId: "reject" } })).status).toBe(400);
    expect(pipeline.instances.get(params.runId)?.events.map((e) => e.type)).toEqual(["gate-outline", "gate-outline", "gate-outline"]);
  });
});
