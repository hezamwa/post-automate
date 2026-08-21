import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb, schema } from "../db/client";
import { createRun } from "../db/commands";
import { checkTopicRequest } from "../modules/discovery";
import { getActiveProfile } from "../modules/profiles";
import { getFlags } from "../shared/flags";
import type { Env } from "../shared/env";
import type { Db } from "../db/client";

// Design §7: run history + triggers. JWT-authenticated (FR-2.2); runs are always
// created for the authenticated user — never for a user named in the request (FR-2.3).
// User-chosen topics go through /request ONLY: it owns the FR-7.7 banned-topic
// warn-and-override flow, which a topic smuggled into /trigger would bypass.

const requestSchema = z
  .object({
    title: z.string().min(1),
    notes: z.string().optional(),
    links: z.array(z.string().url()).max(10).optional(),
    overrideBannedTopics: z.boolean().optional(),
  })
  .strict();

async function launchRun(
  c: { env: Env },
  db: Db,
  args: {
    userId: string;
    profileVersion: number;
    userTopic?: { title: string; notes?: string; links?: string[] };
  },
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
  await db
    .update(schema.pipelineRuns)
    .set({ workflowInstanceId: instance.id })
    .where(eq(schema.pipelineRuns.id, run.id));
  return { runId: run.id, workflowInstanceId: instance.id };
}

export const runs = new Hono<AuthedEnv>()
  .use("*", requireAuth)

  // Run history + states (DR-9.4) — includes angleProposals so the app can render the
  // angle picker for user-requested runs (FR-6.3) and change-angle options (FR-7.9)
  .get("/", async (c) => {
    const rows = await createDb(c.env)
      .select({
        id: schema.pipelineRuns.id,
        trigger: schema.pipelineRuns.trigger,
        state: schema.pipelineRuns.state,
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
    // FR-15.12c: refused before the run row even exists — no skipped-run noise from a pause
    if ((await getFlags(db))["runs.paused"]) {
      return c.json(
        { error: "New pipeline runs are paused by an administrator — resume runs in admin settings (FR-15.12)." },
        503,
      );
    }
    const userId = c.get("userId");
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
    if ((await getFlags(db))["runs.paused"]) {
      return c.json(
        { error: "New pipeline runs are paused by an administrator — resume runs in admin settings (FR-15.12)." },
        503,
      );
    }
    const userId = c.get("userId");
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
    const launched = await launchRun(c, db, {
      userId,
      profileVersion,
      userTopic: { title: topic.title, notes: topic.notes, links: topic.links },
    });
    return c.json({ ...launched, warnings }); // dedup similarity is informational (FR-7.7)
  })

  // FR-6.3: the requester picks one of the 3 proposals; 24h timeout auto-picks
  .post("/:id/angle", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { angleIndex?: unknown };
    if (typeof body.angleIndex !== "number" || !Number.isInteger(body.angleIndex) || body.angleIndex < 0) {
      return c.json({ error: "Body must include { angleIndex: 0 | 1 | 2 }." }, 400);
    }
    const db = createDb(c.env);
    const run = await db.query.pipelineRuns.findFirst({
      where: eq(schema.pipelineRuns.id, c.req.param("id")),
    });
    if (!run || run.userId !== c.get("userId")) return c.json({ error: "run not found" }, 404);
    if (run.trigger !== "user_topic") {
      return c.json({ error: "only user-requested runs wait for an angle choice (FR-6.3)" }, 409);
    }
    if (!run.workflowInstanceId) return c.json({ error: "run has no workflow instance" }, 409);
    try {
      const instance = await c.env.PIPELINE.get(run.workflowInstanceId);
      await instance.sendEvent({ type: "angle-choice", payload: { angleIndex: body.angleIndex } });
    } catch {
      return c.json({ error: "this run is not waiting for an angle choice (it may have timed out and auto-picked)" }, 409);
    }
    return c.json({ ok: true });
  });
