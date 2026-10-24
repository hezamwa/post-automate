import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { RunAbandonedError } from "../../../src/workflows/gates/gate";
import { chooseTopic, topicGate } from "../../../src/workflows/gates/topic";
import { techProfile } from "../../fixtures";
import { candidateRows, runRow, seedCandidates, stepContext } from "../harness";
import { CANDIDATES } from "../mocks";

// The topic gate (spec §4.2/§4.3): auto takes the recommendation without a pause; ask
// waits 2 min → push → 3 d → reminder → 27 d; free text becomes a user-topic research
// run; 30 days of silence abandons the run. Never auto-proceeds on timeout.
beforeEach(resetShared);

async function scoredRun(gates: Partial<ReturnType<typeof techProfile>["gates"]> = {}) {
  const ctx = await stepContext({ profile: techProfile({ gates }) });
  const refs = await seedCandidates(ctx, CANDIDATES);
  await shared.db.update(schema.topicCandidates).set({ score: "8", rejectionReason: "fits", selected: true }).where(eq(schema.topicCandidates.id, refs[0]!.id));
  await shared.db.update(schema.topicCandidates).set({ score: "4", rejectionReason: "meh" }).where(eq(schema.topicCandidates.id, refs[1]!.id));
  await shared.db.update(schema.topicCandidates).set({ score: "7", rejectionReason: "ok" }).where(eq(schema.topicCandidates.id, refs[2]!.id));
  return { ctx, refs };
}

const choicesOf = (runId: string) => shared.db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, runId));

describe("topic gate — options", () => {
  it("lists every scored candidate best first with score and reason, recommending the selected one", async () => {
    const { ctx, refs } = await scoredRun();
    const options = await topicGate.options(ctx);
    expect(options.options.map((o) => o.id)).toEqual([refs[0]!.id, refs[2]!.id, refs[1]!.id]);
    expect(options.options[0]).toMatchObject({ title: "Agents in production", why: expect.stringContaining("score 8/10 — fits") });
    expect("recommended" in options && options.recommended).toBe(refs[0]!.id);
  });
});

describe("topic gate — auto", () => {
  it("takes the recommendation with no wait, records the choice as auto", async () => {
    const { ctx, refs } = await scoredRun();
    const topic = await chooseTopic(shared.step as never, ctx);
    expect(topic.id).toBe(refs[0]!.id);
    expect(shared.step.waits).toEqual([]);
    expect(shared.pushes).toEqual([]);
    expect(await choicesOf(ctx.runId)).toMatchObject([{ gate: "topic", source: "auto", choice: { optionId: refs[0]!.id }, freeText: null }]);
    expect(await runRow(ctx.runId)).toMatchObject({ chosenTopicId: refs[0]!.id, gate: null });
  });
});

describe("topic gate — ask", () => {
  it("answered within two minutes: no push, the pick becomes the selected candidate", async () => {
    const { ctx, refs } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", payload: { optionId: refs[2]!.id } });
    const topic = await chooseTopic(shared.step as never, ctx);
    expect(topic).toMatchObject({ id: refs[2]!.id, title: "Rust in the browser", whyItMatters: "tooling" });
    expect(shared.step.waits.map((w) => w.outcome)).toEqual(["answered"]);
    expect(shared.pushes).toEqual([]);
    const rows = await candidateRows(ctx.runId);
    expect(rows.filter((r) => r.selected).map((r) => r.id)).toEqual([refs[2]!.id]);
    expect(await runRow(ctx.runId)).toMatchObject({ chosenTopicId: refs[2]!.id, gate: null });
    expect(await choicesOf(ctx.runId)).toMatchObject([{ source: "user", optionsShown: { options: expect.any(Array) } }]);
  });

  it("marks the run as waiting on the gate while parked", async () => {
    const { ctx } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", timeout: true }, { type: "gate-topic", timeout: true }, { type: "gate-topic", timeout: true });
    await chooseTopic(shared.step as never, ctx).catch(() => {});
    expect(shared.step.executed).toContain("gate-topic-open");
    expect((await runRow(ctx.runId))?.gate).toBe("topic");
  });

  it("silent for two minutes → push, answered within three days → continues, one push only", async () => {
    const { ctx, refs } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", timeout: true }, { type: "gate-topic", payload: { optionId: refs[0]!.id } });
    await chooseTopic(shared.step as never, ctx);
    expect(shared.step.waits.map((w) => w.outcome)).toEqual(["timeout", "answered"]);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Your input is needed"]);
    expect(shared.pushes[0]?.data).toMatchObject({ runId: ctx.runId, gate: "topic" });
  });

  it("three days of silence → reminder, answered later → continues", async () => {
    const { ctx, refs } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", timeout: true }, { type: "gate-topic", timeout: true }, { type: "gate-topic", payload: { optionId: refs[0]!.id } });
    await chooseTopic(shared.step as never, ctx);
    expect(shared.step.waits.map((w) => w.outcome)).toEqual(["timeout", "timeout", "answered"]);
    expect(shared.pushes.map((p) => p.title)).toEqual(["Your input is needed", "Still waiting for your choice"]);
  });

  it("30 days without an answer → the run is ABANDONED with the reason, never auto-proceeded", async () => {
    const { ctx } = await scoredRun({ topic: "ask" });
    await expect(chooseTopic(shared.step as never, ctx)).rejects.toThrow(RunAbandonedError);
    expect(shared.step.waits.map((w) => w.outcome)).toEqual(["timeout", "timeout", "timeout"]);
    expect(await runRow(ctx.runId)).toMatchObject({ state: "abandoned", error: expect.stringContaining("topic gate"), finishedAt: expect.any(Date) });
    expect(await choicesOf(ctx.runId)).toEqual([]);
    expect(shared.ai.calls).toEqual([]); // nothing spent past the gate
  });

  it("free text routes the run through search + research as a user-topic run (spec §4.3)", async () => {
    const { ctx } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", payload: { freeText: "Something about WASM instead" } });
    const topic = await chooseTopic(shared.step as never, ctx);
    expect(shared.step.executed).toEqual(expect.arrayContaining(["gate-topic", "search-topic", "research-topic"]));
    expect(shared.ai.callsFor("research")[0]!.input.messages[0]!.content).toContain("Something about WASM instead");
    expect(topic).toMatchObject({ title: "Agents in production" }); // the (mocked) research brief
    expect(await runRow(ctx.runId)).toMatchObject({ userTopic: { title: "Something about WASM instead" } });
    expect(await choicesOf(ctx.runId)).toMatchObject([{ freeText: "Something about WASM instead" }]);
  });

  it("rejects an answer that is neither an option id nor free text", async () => {
    const { ctx } = await scoredRun({ topic: "ask" });
    shared.step.script({ type: "gate-topic", payload: { optionId: "not-a-uuid" } });
    await expect(chooseTopic(shared.step as never, ctx)).rejects.toThrow();
  });
});
