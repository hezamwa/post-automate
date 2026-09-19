import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import type { Env } from "../shared/env";
import { notifyUser } from "../shared/notify";

// Draft reminders (spec §5 "nothing is lost"): a pending draft is nudged on day 6, then
// every 7 days, forever — there is no expiry. Daily cadence means each draft lands on
// each reminder day exactly once. Muted when the creator opened the draft in the last 24
// hours AND has been in the app today: they know, they are around. Free — no AI call.

const DAY_MS = 24 * 3600_000;
export const FIRST_REMINDER_DAY = 6;
export const REMINDER_EVERY_DAYS = 7;

export function isReminderDay(ageDays: number): boolean {
  return ageDays >= FIRST_REMINDER_DAY && (ageDays - FIRST_REMINDER_DAY) % REMINDER_EVERY_DAYS === 0;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Selection is pure over the rows; returns how many reminders went out. */
export async function draftReminders(env: Env, db: Db, now = new Date()): Promise<number> {
  const pending = await db
    .select({
      id: schema.drafts.id,
      userId: schema.drafts.userId,
      runId: schema.drafts.runId,
      createdAt: schema.drafts.createdAt,
      seenAt: schema.drafts.seenAt,
      lastActiveAt: schema.users.lastActiveAt,
    })
    .from(schema.drafts)
    .innerJoin(schema.users, eq(schema.users.id, schema.drafts.userId))
    .where(eq(schema.drafts.status, "pending_approval"));

  let sent = 0;
  for (const d of pending) {
    const ageDays = Math.floor((now.getTime() - d.createdAt.getTime()) / DAY_MS);
    if (!isReminderDay(ageDays)) continue;
    const seenRecently = d.seenAt != null && now.getTime() - d.seenAt.getTime() < DAY_MS;
    const activeToday = d.lastActiveAt != null && sameUtcDay(d.lastActiveAt, now);
    if (seenRecently && activeToday) continue;
    await notifyUser(env, db, d.userId, {
      title: "Draft waiting for your review",
      body: `A draft has been waiting ${ageDays} days — approve, edit or reject it whenever you like; it will not expire.`,
      data: { draftId: d.id, runId: d.runId },
    });
    sent++;
  }
  return sent;
}
