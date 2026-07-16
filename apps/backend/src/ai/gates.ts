import { and, count, eq, gte, inArray, ne } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { monthToDateUsd, recentCallCount } from "./meter";

// Budget & rate gates checked before EVERY AI call (design §10 layers 2–3).
// Every refusal is a human-readable message — never a silent skip (FR-15.8/15.10).

export const DEFAULT_GLOBAL_CAP_USD = 20; // NFR-11.5; admin-mutable via app_config

export class GateError extends Error {
  constructor(
    public gate: "global_cap" | "user_cap" | "user_rate" | "user_runs",
    message: string,
  ) {
    super(message);
    this.name = "GateError";
  }
}

/** Not an error condition — the run should be recorded as `skipped`, not `failed` (FR-7.4). */
export class SkipRunError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "SkipRunError";
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

/**
 * Run-level gate (Workflow "gates" step, design §5/§10): the AI money/rate gates, plus
 * runs-per-day (FR-15.8), plus the pending-drafts pause — which user-requested runs
 * bypass (FR-7.4/7.7). Throws GateError (→ failed) or SkipRunError (→ skipped).
 */
export async function assertRunnable(
  db: Db,
  userId: string,
  opts: { runId: string; userRequested?: boolean },
): Promise<GateStatus> {
  const status = await assertAiAllowed(db, userId);

  const limits = await db.query.userLimits.findFirst({
    where: eq(schema.userLimits.userId, userId),
  });
  const maxRunsPerDay = limits?.maxRunsPerDay ?? 2;
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const [runsRow] = await db
    .select({ n: count() })
    .from(schema.pipelineRuns)
    .where(
      and(
        eq(schema.pipelineRuns.userId, userId),
        gte(schema.pipelineRuns.startedAt, todayUtc),
        ne(schema.pipelineRuns.id, opts.runId), // the current run's own row doesn't count
      ),
    );
  if ((runsRow?.n ?? 0) >= maxRunsPerDay) {
    throw new GateError(
      "user_runs",
      `Daily run limit reached (${maxRunsPerDay}/day) — the next scheduled run is tomorrow; an admin can raise the limit (FR-15.8).`,
    );
  }

  if (!opts.userRequested) {
    const [pendingRow] = await db
      .select({ n: count() })
      .from(schema.drafts)
      .where(
        and(
          eq(schema.drafts.userId, userId),
          inArray(schema.drafts.status, ["pending_approval", "revising"]),
        ),
      );
    if ((pendingRow?.n ?? 0) >= 2) {
      throw new SkipRunError("2 drafts already awaiting review — run skipped, reminder sent instead (FR-7.4)");
    }
  }
  return status;
}
