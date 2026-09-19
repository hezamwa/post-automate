import { and, eq, isNotNull, lte } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { createRun } from "../db/commands";
import { undecidedDraft } from "../db/queries";
import { getActiveProfile } from "../modules/profiles";
import type { Env } from "../shared/env";
import { isActive } from "./activity";
import { nudgeSilentCreators } from "./nudges";
import { draftReminders } from "./reminders";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Daily 06:00 UTC (spec §2). A scheduled run launches only for a creator who opted in
 * (profile.autoRun), was active in the last 7 days, has today in their preferred days,
 * and has no undecided draft. Everyone else gets nothing — no run, no spend. Then the
 * free jobs: transcript purge (OD-7), draft reminders, the silence nudge.
 */
export async function dailyDispatch(env: Env, db: Db, now = new Date()): Promise<{ launched: string[]; skipped: Array<[string, string]> }> {
  const today = DAY_NAMES[now.getUTCDay()]!;
  const launched: string[] = [];
  const skipped: Array<[string, string]> = [];
  for (const user of await db.select().from(schema.users)) {
    const why = await dispatchBlocker(db, user, today, now);
    if (why) {
      skipped.push([user.id, why]);
      continue;
    }
    const { version } = await getActiveProfile(db, user.id);
    const run = await createRun(db, { userId: user.id, trigger: "cron", profileVersion: version });
    const instance = await env.PIPELINE.create({ id: run.id, params: { runId: run.id, userId: user.id } });
    await db.update(schema.pipelineRuns).set({ workflowInstanceId: instance.id }).where(eq(schema.pipelineRuns.id, run.id));
    console.log("dispatcher: run launched", { userId: user.id, runId: run.id });
    launched.push(run.id);
  }

  await db
    .delete(schema.onboardingSessions)
    .where(and(isNotNull(schema.onboardingSessions.purgeAfter), lte(schema.onboardingSessions.purgeAfter, now)));
  await draftReminders(env, db, now);
  await nudgeSilentCreators(env, db, now);
  return { launched, skipped };
}

/** The first of the four conditions that fails, as a reason — or null when all hold. */
async function dispatchBlocker(db: Db, user: typeof schema.users.$inferSelect, today: (typeof DAY_NAMES)[number], now: Date): Promise<string | null> {
  let profile;
  try {
    profile = (await getActiveProfile(db, user.id)).profile;
  } catch (e) {
    return e instanceof Error ? e.message : "no active profile";
  }
  if (!profile.autoRun) return "autoRun off";
  if (!isActive(user, now)) return "inactive for 7 days";
  if (!profile.cadence.preferredDays.includes(today)) return `not a preferred day (${today})`;
  if (await undecidedDraft(db, user.id)) return "a draft is undecided";
  return null;
}
