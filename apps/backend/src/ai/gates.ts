import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { monthToDateUsd, recentCallCount } from "./meter";

// Budget & rate gates checked before EVERY AI call (design §10 layers 2–3).
// Every refusal is a human-readable message — never a silent skip (FR-15.8/15.10).

export const DEFAULT_GLOBAL_CAP_USD = 20; // NFR-11.5; admin-mutable via app_config

export class GateError extends Error {
  constructor(
    public gate: "global_cap" | "user_cap" | "user_rate",
    message: string,
  ) {
    super(message);
    this.name = "GateError";
  }
}

export async function getGlobalCapUsd(db: Db): Promise<number> {
  const row = await db.query.appConfig.findFirst({
    where: eq(schema.appConfig.key, "global_monthly_cap_usd"),
  });
  return row ? Number(row.value) : DEFAULT_GLOBAL_CAP_USD;
}

export interface GateStatus {
  globalSpentUsd: number;
  globalCapUsd: number;
  userSpentUsd?: number;
  userCapUsd?: number;
}

export async function assertAiAllowed(
  db: Db,
  userId: string | null,
  opts: { bypassGlobalCap?: boolean } = {},
): Promise<GateStatus> {
  const globalCapUsd = await getGlobalCapUsd(db);
  const globalSpentUsd = await monthToDateUsd(db);
  // Sole bypass: explicitly admin-triggered route tests (design §10 layer 2)
  if (!opts.bypassGlobalCap && globalSpentUsd >= globalCapUsd) {
    throw new GateError(
      "global_cap",
      `Global AI budget ($${globalCapUsd}) exhausted — all AI activity is paused until next month or until the cap is raised in admin settings (FR-15.10).`,
    );
  }

  const status: GateStatus = { globalSpentUsd, globalCapUsd };
  if (!userId) return status;

  const limits = await db.query.userLimits.findFirst({
    where: eq(schema.userLimits.userId, userId),
  });
  const userCapUsd = Number(limits?.monthlyCapUsd ?? 10);
  const maxReqPerMin = limits?.maxReqPerMin ?? 30;

  const userSpentUsd = await monthToDateUsd(db, userId);
  if (userSpentUsd >= userCapUsd) {
    throw new GateError(
      "user_cap",
      `Monthly AI budget ($${userCapUsd}) reached — it resets on the 1st; an admin can raise the cap in settings if needed (FR-15.8).`,
    );
  }
  const callsLastMinute = await recentCallCount(db, userId, 60);
  if (callsLastMinute >= maxReqPerMin) {
    throw new GateError(
      "user_rate",
      `Rate limit reached (${maxReqPerMin} AI calls/minute) — wait a moment and retry (FR-15.8).`,
    );
  }
  return { ...status, userSpentUsd, userCapUsd };
}
