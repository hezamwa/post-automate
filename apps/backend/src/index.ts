import { and, eq, isNotNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { api } from "./api";
import { createDb, schema, type Db } from "./db/client";
import { createRun, getUserById, setRunState } from "./db/commands";
import { getActiveProfile } from "./modules/profiles";
import { publishApprovedDraft } from "./modules/publishing";
import type { Env } from "./shared/env";

export { PipelineWorkflow } from "./workflows/pipeline";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route("/", api);

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Daily 06:00 UTC — launch runs for users due today (FR-3.6) + purge old transcripts (OD-7). */
async function dailyDispatch(env: Env, db: Db): Promise<void> {
  const today = DAY_NAMES[new Date().getUTCDay()]!;
  const users = await db.select().from(schema.users);
  for (const user of users) {
    try {
      const { version, profile } = await getActiveProfile(db, user.id);
      if (!profile.cadence.preferredDays.includes(today)) continue;
      const run = await createRun(db, { userId: user.id, trigger: "cron", profileVersion: version });
      const instance = await env.PIPELINE.create({
        id: run.id,
        params: { runId: run.id, userId: user.id },
      });
      await db
        .update(schema.pipelineRuns)
        .set({ workflowInstanceId: instance.id })
        .where(eq(schema.pipelineRuns.id, run.id));
      console.log("dispatcher: run launched", { userId: user.id, runId: run.id });
    } catch (e) {
      // no active profile (or gate) — skip quietly; gates inside the run handle the rest
      console.log("dispatcher: skipped user", user.id, e instanceof Error ? e.message : e);
    }
  }
  // OD-7: purge onboarding transcripts past their retention date
  await db
    .delete(schema.onboardingSessions)
    .where(and(isNotNull(schema.onboardingSessions.purgeAfter), lte(schema.onboardingSessions.purgeAfter, new Date())));
}

/** Hourly — publish scheduled drafts whose slot has arrived (FR-7.5). */
async function hourlyPublish(env: Env, db: Db): Promise<void> {
  const due = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.status, "scheduled"), lte(schema.drafts.publishAt, new Date())));
  for (const draft of due) {
    try {
      const user = await getUserById(db, draft.userId);
      await publishApprovedDraft(env, db, { user, draftId: draft.id }); // production-only (FR-8.5)
      await setRunState(db, draft.runId, "published");
      console.log("publisher: published", { draftId: draft.id });
    } catch (e) {
      console.error("publisher: failed", draft.id, e instanceof Error ? e.message : e);
    }
  }
}

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    const db = createDb(env);
    switch (controller.cron) {
      case "0 6 * * *":
        ctx.waitUntil(dailyDispatch(env, db));
        break;
      case "0 * * * *":
        ctx.waitUntil(hourlyPublish(env, db));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
