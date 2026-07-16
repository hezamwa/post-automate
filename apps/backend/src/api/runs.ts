import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, schema } from "../db/client";
import { createRun } from "../db/commands";
import { getActiveProfile } from "../modules/profiles";
import type { Env } from "../shared/env";
import { notImplemented } from "./stub";

// Design §7: run history + triggers. /trigger is Phase 1's manual entry point —
// auth arrives in Phase 2, so it refuses in production until then.
export const runs = new Hono<{ Bindings: Env }>()
  .get("/", notImplemented)
  .post("/trigger", async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "Manual trigger requires auth (Phase 2) — refused in production" }, 501);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      topic?: { title: string; notes?: string; links?: string[] };
    };
    if (!body.email) {
      return c.json({ error: "Body must include { email } of the creator to run for" }, 400);
    }
    const db = createDb(c.env);
    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, body.email),
    });
    if (!user) return c.json({ error: `No user with email ${body.email}` }, 404);

    let profileVersion: number;
    try {
      profileVersion = (await getActiveProfile(db, user.id)).version;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "no active profile" }, 409);
    }

    const run = await createRun(db, {
      userId: user.id,
      trigger: body.topic ? "user_topic" : "manual",
      profileVersion,
      userTopic: body.topic,
    });
    const instance = await c.env.PIPELINE.create({
      id: run.id,
      params: { runId: run.id, userId: user.id, userTopic: body.topic },
    });
    await db
      .update(schema.pipelineRuns)
      .set({ workflowInstanceId: instance.id })
      .where(eq(schema.pipelineRuns.id, run.id));
    return c.json({ runId: run.id, workflowInstanceId: instance.id });
  })
  // {title, notes?, links[]?, overrideBannedTopics?} — user-requested topic (FR-5.8, FR-7.7)
  .post("/request", notImplemented)
  .post("/:id/angle", notImplemented); // {angleIndex} → angle-choice event (FR-6.3)
