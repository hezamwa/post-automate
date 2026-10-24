import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { EXPIRY_WARNING_DAYS } from "../modules/social/accounts";
import type { Env } from "../shared/env";
import { notifyUser } from "../shared/notify";

// FR-18.7: a connection with no refresh token (LinkedIn's standard app) gets one
// "reconnect" push when it is within 7 days of expiring. A reconnect clears the marker.

const NAMES = { x: "X", linkedin: "LinkedIn" } as const;

export async function remindExpiringConnections(env: Env, db: Db, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);
  const due = await db
    .select()
    .from(schema.socialAccounts)
    .where(
      and(
        isNull(schema.socialAccounts.refreshTokenEnc),
        isNull(schema.socialAccounts.expiryRemindedAt),
        gt(schema.socialAccounts.expiresAt, now),
        lte(schema.socialAccounts.expiresAt, horizon),
      ),
    );
  for (const row of due) {
    const days = Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 86_400_000));
    await notifyUser(env, db, row.userId, {
      title: `Reconnect ${NAMES[row.provider]}`,
      body: `Your ${NAMES[row.provider]} connection expires in ${days} day${days > 1 ? "s" : ""}. Open Profile → Connected accounts to reconnect, so your posts keep going out.`,
      data: { action: "reconnect", provider: row.provider },
    });
    await db.update(schema.socialAccounts).set({ expiryRemindedAt: now }).where(eq(schema.socialAccounts.id, row.id));
  }
  return due.length;
}
