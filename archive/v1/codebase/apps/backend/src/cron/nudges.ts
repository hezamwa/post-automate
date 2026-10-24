import { schema, type Db } from "../db/client";
import { eq } from "drizzle-orm";
import type { Env } from "../shared/env";
import { notifyUser } from "../shared/notify";
import { undecidedDraft } from "../db/queries";
import { ACTIVE_WINDOW_DAYS, daysSince, isActive, lastSeen } from "./activity";

// The silence nudge (spec §2): after 7 days without an app request and with no pending
// draft, "tap to get a draft on what's trending" — at most once a week, free.

export async function nudgeSilentCreators(env: Env, db: Db, now = new Date()): Promise<number> {
  let sent = 0;
  for (const user of await db.select().from(schema.users)) {
    if (user.role !== "user" || user.suspendedAt) continue;
    if (isActive(user, now)) continue;
    if (user.lastNudgedAt && daysSince(user.lastNudgedAt, now) < ACTIVE_WINDOW_DAYS) continue;
    if (await undecidedDraft(db, user.id)) continue; // that draft has its own reminders
    await notifyUser(env, db, user.id, {
      title: "Anything to write this week?",
      body: `It has been ${daysSince(lastSeen(user), now)} days — tap Generate to get a draft on what's trending in your field.`,
      data: { action: "generate" },
    });
    await db.update(schema.users).set({ lastNudgedAt: now }).where(eq(schema.users.id, user.id));
    sent++;
  }
  return sent;
}
