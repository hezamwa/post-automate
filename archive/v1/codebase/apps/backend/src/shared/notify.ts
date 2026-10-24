import { and, eq, isNotNull } from "drizzle-orm";
import type { GateStatus } from "../ai/gates";
import { schema, type Db } from "../db/client";
import { crossedThresholds } from "./budget";
import type { Env } from "./env";
import { sendFcmPush, type PushMessage } from "./fcm";

// Notification fan-out (FR-7.1, FR-15.11 "monitoring is active"). Everything here is
// best-effort: a missing token or a failed send logs and returns, never throws.

type Fetcher = typeof fetch;

/** Push to one user's device. False when they have no registered token or the send failed. */
export async function notifyUser(
  env: Env,
  db: Db,
  userId: string,
  msg: PushMessage,
  fetchImpl: Fetcher = fetch,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { fcmToken: true },
  });
  if (!user?.fcmToken) {
    console.log(`notify: user ${userId} has no FCM token — skipped: ${msg.title}`);
    return false;
  }
  return sendFcmPush(env, user.fcmToken, msg, fetchImpl);
}

/** Push to every admin with a registered device (FR-15.11). Returns how many were sent. */
export async function notifyAdmins(
  env: Env,
  db: Db,
  msg: PushMessage,
  fetchImpl: Fetcher = fetch,
): Promise<number> {
  const admins = await db
    .select({ fcmToken: schema.users.fcmToken })
    .from(schema.users)
    .where(and(eq(schema.users.role, "admin"), isNotNull(schema.users.fcmToken)));
  let sent = 0;
  for (const a of admins) {
    if (await sendFcmPush(env, a.fcmToken!, msg, fetchImpl)) sent++;
  }
  if (admins.length === 0) console.log(`notify: no admin has an FCM token — dropped: ${msg.title}`);
  return sent;
}

/**
 * Budget threshold alerts (FR-15.10/15.11, design §10): fired exactly when a call's cost
 * crosses 80%/100% — stateless, so no repeat pushes once above a line. Global crossings
 * go to admins; per-user crossings go to the user and admins. Never throws.
 */
export async function maybeBudgetAlerts(
  env: Env,
  db: Db,
  args: { gate: GateStatus; costUsd: number; userId: string | null },
  fetchImpl: Fetcher = fetch,
): Promise<void> {
  try {
    const { gate, costUsd, userId } = args;
    for (const pct of crossedThresholds(gate.globalSpentUsd, costUsd, gate.globalCapUsd)) {
      await notifyAdmins(env, db, {
        title: `Global AI budget at ${pct}%`,
        body: `Month-to-date spend crossed ${pct}% of the $${gate.globalCapUsd} global cap (FR-15.10).${pct >= 100 ? " All AI calls are now refused." : ""}`,
      }, fetchImpl);
    }
    if (userId && gate.userSpentUsd != null && gate.userCapUsd != null) {
      for (const pct of crossedThresholds(gate.userSpentUsd, costUsd, gate.userCapUsd)) {
        const msg = {
          title: `AI budget at ${pct}%`,
          body: `Monthly AI spend crossed ${pct}% of the $${gate.userCapUsd} cap (FR-15.8).${pct >= 100 ? " Further AI work is refused until it resets." : ""}`,
        };
        await notifyUser(env, db, userId, msg, fetchImpl);
        await notifyAdmins(env, db, { ...msg, body: `A creator's ${msg.body.charAt(0).toLowerCase()}${msg.body.slice(1)}` }, fetchImpl);
      }
    }
  } catch (e) {
    console.warn("budget alert push failed:", e instanceof Error ? e.message : e);
  }
}
