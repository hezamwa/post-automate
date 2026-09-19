import { and, eq, isNotNull, lte } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { createRun } from "../db/commands";
import { getActiveProfile } from "../modules/profiles";
import type { Env } from "../shared/env";
import { draftReminders } from "./reminders";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Daily 06:00 UTC — launch runs for users due today (FR-3.6) + purge old transcripts (OD-7). */
export async function dailyDispatch(env: Env, db: Db): Promise<void> {
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

  // Free jobs (spec §2): draft reminders on day 6, then weekly — no expiry (spec §5).
  await draftReminders(env, db);
}
