import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api";
import { createDb, schema, type Db } from "./db/client";
import { createRun, getUserById, setRunState } from "./db/commands";
import { getActiveProfile } from "./modules/profiles";
import { publishApprovedDraft } from "./modules/publishing";
import { backupSanityDatasets } from "./shared/backup";
import type { Env } from "./shared/env";
import { getFlags } from "./shared/flags";
import { notifyUser } from "./shared/notify";

export { PipelineWorkflow } from "./workflows/pipeline";

const app = new Hono<{ Bindings: Env }>();
// CORS: only the Flutter web dev origin, and only outside production — native mobile
// apps never preflight, and the deployed web/admin surfaces are served same-origin.
app.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production") return next();
  return cors({
    origin: "http://localhost:8090", // tools/run-web.sh — pinned web dev port
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE"],
  })(c, next);
});
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

  // design §9: "draft expiring in 24h" push — pending drafts in day 6 of their 7-day wait.
  // Daily cadence means each draft lands in this window exactly once.
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600_000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const expiring = await db
    .select({ id: schema.drafts.id, userId: schema.drafts.userId, runId: schema.drafts.runId })
    .from(schema.drafts)
    .where(
      and(
        eq(schema.drafts.status, "pending_approval"),
        lte(schema.drafts.createdAt, sixDaysAgo),
        gte(schema.drafts.createdAt, sevenDaysAgo),
      ),
    );
  for (const d of expiring) {
    await notifyUser(env, db, d.userId, {
      title: "Draft expires in 24 hours",
      body: "A draft has been waiting 6 days — review it before the 7-day timeout expires it.",
      data: { draftId: d.id, runId: d.runId },
    });
  }
}

/** Hourly — publish scheduled drafts whose slot has arrived (FR-7.5). */
async function hourlyPublish(env: Env, db: Db): Promise<void> {
  const due = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.status, "scheduled"), lte(schema.drafts.publishAt, new Date())));
  // publishApprovedDraft is the authoritative publishing.paused check (FR-15.12b); this
  // early exit only keeps a deliberate pause from logging as per-draft FAILURES each hour.
  if (due.length > 0 && (await getFlags(db))["publishing.paused"]) {
    console.log(`publisher: publishing.paused — ${due.length} due draft(s) held, will publish once resumed`);
    return;
  }
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
      case "0 3 * * 0": // weekly Sanity dataset export → R2 (NFR-16.3)
        ctx.waitUntil(backupSanityDatasets(env, db));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
