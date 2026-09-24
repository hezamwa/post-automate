import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb, schema } from "../db/client";
import { createRun } from "../db/commands";
import { gateChoicesForRun, getDraftByRun, undecidedDraft } from "../db/queries";
import { checkTopicRequest } from "../modules/discovery";
import { getActiveProfile } from "../modules/profiles";
import { getFlags } from "../shared/flags";
import type { Env } from "../shared/env";
import type { Db } from "../db/client";
import { runContextFor } from "../workflows/direct";
import { answerableGate } from "../workflows/gates/registry";
import { gateEventType } from "../workflows/gates/wait";

// Design §7: run history, triggers, and gates (spec §4). JWT-authenticated (FR-2.2); runs
// are always created for the authenticated user — never for a user named in the request
// (FR-2.3). User-chosen topics go through /request ONLY: it owns the FR-7.7 banned-topic
// warn-and-override flow, which a topic smuggled into /trigger would bypass.

const requestSchema = z
  .object({
    title: z.string().min(1),
    notes: z.string().optional(),
    links: z.array(z.string().url()).max(10).optional(),
    overrideBannedTopics: z.boolean().optional(),
  })
  .strict();

const RUNS_PAUSED = { error: "New pipeline runs are paused by an administrator — resume runs in admin settings (FR-15.12)." };

/**
 * Spec §2 / FR-7.4 (v2): one undecided draft is the limit. The Generate button opens it
 * instead of starting a run — 409 with the draft id so the app can deep-link. The entry
 * gates inside the run are the backstop.
 */
async function refuseWhilePending(db: Db, userId: string) {
  const pending = await undecidedDraft(db, userId);
  if (!pending) return null;
  return {
    error: "A draft is already waiting for your decision — approve, edit or reject it before starting a new run (FR-7.4).",
    existingDraftId: pending.id,
  };
}

async function launchRun(
  c: { env: Env },
  db: Db,
  args: { userId: string; profileVersion: number; userTopic?: { title: string; notes?: string; links?: string[] } },
): Promise<{ runId: string; workflowInstanceId: string }> {
  const run = await createRun(db, {
    userId: args.userId,
    trigger: args.userTopic ? "user_topic" : "manual",
    profileVersion: args.profileVersion,
    userTopic: args.userTopic,
  });
  const instance = await c.env.PIPELINE.create({
    id: run.id,
    params: { runId: run.id, userId: args.userId, userTopic: args.userTopic },
  });
  await db.update(schema.pipelineRuns).set({ workflowInstanceId: instance.id }).where(eq(schema.pipelineRuns.id, run.id));
  return { runId: run.id, workflowInstanceId: instance.id };
}

async function ownRun(db: Db, runId: string, userId: string) {
  const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, runId) });
  return run && run.userId === userId ? run : null;
}

/** Deliver a gate answer to the live instance; 409 (as a message) when the run is not waiting on it. */
async function answerGate(c: { env: Env }, db: Db, run: typeof schema.pipelineRuns.$inferSelect, gateName: string, body: unknown) {
  const gate = answerableGate(gateName);
  if (!gate) return { status: 404 as const, json: { error: `unknown gate '${gateName}' — answerable gates: topic, angle` } };
  const parsed = gate.choice.safeParse(body);
  if (!parsed.success) return { status: 400 as const, json: { error: `invalid answer for the ${gateName} gate: ${parsed.error.issues[0]?.message ?? "bad body"}` } };
  if (run.gate !== gateName) {
    return { status: 409 as const, json: { error: run.gate ? `this run is waiting on the ${run.gate} gate, not ${gateName}` : "this run is not waiting on any gate" } };
  }
  if (!run.workflowInstanceId) return { status: 409 as const, json: { error: "run has no workflow instance" } };
  try {
    const instance = await c.env.PIPELINE.get(run.workflowInstanceId);
    await instance.sendEvent({ type: gateEventType(gateName), payload: parsed.data });
  } catch {
    return { status: 409 as const, json: { error: `the run's instance is not reachable — it may have been abandoned (spec §4.2)` } };
  }
  return { status: 200 as const, json: { ok: true } };
}

export const runs = new Hono<AuthedEnv>()
  .use("*", requireAuth)

  // Run history + states (DR-9.4) — includes angleProposals so the app can render the
  // angle picker and change-angle options (FR-7.9)
  .get("/", async (c) => {
    const rows = await createDb(c.env)
      .select({
        id: schema.pipelineRuns.id,
        trigger: schema.pipelineRuns.trigger,
        state: schema.pipelineRuns.state,
        gate: schema.pipelineRuns.gate,
        error: schema.pipelineRuns.error,
        userTopic: schema.pipelineRuns.userTopic,
        angleProposals: schema.pipelineRuns.angleProposals,
        profileVersion: schema.pipelineRuns.profileVersion,
        startedAt: schema.pipelineRuns.startedAt,
        finishedAt: schema.pipelineRuns.finishedAt,
      })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.userId, c.get("userId")))
      .orderBy(desc(schema.pipelineRuns.startedAt))
      .limit(50);
    return c.json({ runs: rows });
  })

  // Manual pipeline run — discovery picks the topic. For a topic of your own, use /request.
  .post("/trigger", async (c) => {
    const db = createDb(c.env);
    if ((await getFlags(db))["runs.paused"]) return c.json(RUNS_PAUSED, 503); // FR-15.12c: before the run row exists
    const userId = c.get("userId");
    const pending = await refuseWhilePending(db, userId);
    if (pending) return c.json(pending, 409);
    let profileVersion: number;
    try {
      profileVersion = (await getActiveProfile(db, userId)).version;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "no active profile" }, 409);
    }
    return c.json(await launchRun(c, db, { userId, profileVersion }));
  })

  // FR-5.8/FR-7.7: user-requested topic. Banned-topic collisions warn and require
  // overrideBannedTopics: true on resubmit; the 30-day dedup informs but never blocks;
  // budget caps and rate limits apply unchanged inside the run's gates.
  .post("/request", async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const topic = parsed.data;
    const db = createDb(c.env);
    if ((await getFlags(db))["runs.paused"]) return c.json(RUNS_PAUSED, 503);
    const userId = c.get("userId");
    const pending = await refuseWhilePending(db, userId);
    if (pending) return c.json(pending, 409);
    let profileVersion: number;
    let warnings;
    try {
      const active = await getActiveProfile(db, userId);
      profileVersion = active.version;
      warnings = await checkTopicRequest(db, active.profile, userId, topic);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "no active profile" }, 409);
    }
    if (warnings.bannedCollisions.length > 0 && !topic.overrideBannedTopics) {
      return c.json(
        {
          error: `This topic collides with your banned-topics list: ${warnings.bannedCollisions.join("; ")}. Resubmit with overrideBannedTopics: true to proceed anyway (FR-7.7).`,
          warnings,
          requiresOverride: true,
        },
        409,
      );
    }
    const launched = await launchRun(c, db, { userId, profileVersion, userTopic: { title: topic.title, notes: topic.notes, links: topic.links } });
    return c.json({ ...launched, warnings }); // dedup similarity is informational (FR-7.7)
  })

  // Spec §4 / brief §6: one payload renders any gate — state, the gate the run is waiting
  // on with its options, and every choice made so far.
  .get("/:id", async (c) => {
    const db = createDb(c.env);
    const run = await ownRun(db, c.req.param("id"), c.get("userId"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const waiting = run.gate ? answerableGate(run.gate) : undefined;
    const options = waiting ? await waiting.options(await runContextFor(c.env, db, run)) : null;
    const { workflowInstanceId: _instance, ...row } = run;
    return c.json({
      run: row,
      // the run's draft, once saved — the app opens it for the publish gate (design §15)
      draftId: (await getDraftByRun(db, run.id))?.id ?? null,
      gate: run.gate ? { name: run.gate, ...(options ?? {}) } : null,
      choices: (await gateChoicesForRun(db, run.id)).map((g) => ({ gate: g.gate, choice: g.choice, freeText: g.freeText, source: g.source, chosenAt: g.chosenAt })),
    });
  })

  // Spec §4 / brief §6: answer the gate the run is waiting on — { optionId } | { freeText }.
  .post("/:id/gates/:gate", async (c) => {
    const db = createDb(c.env);
    const run = await ownRun(db, c.req.param("id"), c.get("userId"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const result = await answerGate(c, db, run, c.req.param("gate"), await c.req.json().catch(() => ({})));
    return c.json(result.json, result.status);
  })

  // Deprecated alias for the angle gate (the shipped app still posts { angleIndex } here).
  .post("/:id/angle", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { angleIndex?: unknown };
    if (typeof body.angleIndex !== "number" || !Number.isInteger(body.angleIndex) || body.angleIndex < 0) {
      return c.json({ error: "Body must include { angleIndex: 0 | 1 | 2 }." }, 400);
    }
    const db = createDb(c.env);
    const run = await ownRun(db, c.req.param("id"), c.get("userId"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const result = await answerGate(c, db, run, "angle", { optionId: String(body.angleIndex) });
    return c.json(result.json, result.status);
  });
