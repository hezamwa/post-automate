import { and, count, eq, gte, inArray, ne } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { getFlags } from "../shared/flags";
import { monthToDateUsd, recentCallCount } from "./meter";

// Kill-switch, budget & rate gates checked before EVERY AI call (design §10 layers 2–3,
// §10.1). Every refusal is a human-readable message — never a silent skip (FR-15.8/15.10/15.12).

export class GateError extends Error {
  constructor(
    public gate:
      | "ai_paused"
      | "publishing_paused"
      | "user_suspended"
      | "global_cap"
      | "user_cap"
      | "user_rate"
      | "user_runs",
    message: string,
  ) {
    super(message);
    this.name = "GateError";
  }
}

/** Not an error condition — the run should be recorded as `skipped`, not `failed` (FR-7.4). */
export class SkipRunError extends Error {
  constructor(
    public reason: string,
    /** pending_drafts skips send the FR-7.4 reminder push; a pause does not. */
    public kind: "pending_drafts" | "runs_paused" = "pending_drafts",
  ) {
    super(reason);
    this.name = "SkipRunError";
  }
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
  opts: { adminRouteTest?: boolean } = {},
): Promise<GateStatus> {
  const flags = await getFlags(db);
  // FR-15.12a: the stop button. Enforced here — the choke point both router entry
  // points call — rather than at run entry, so it halts in-flight runs too: a run can
  // park at approval for days, and every step re-reads the switch on resumption (§10.1).
  // Bypass: explicitly admin-triggered route tests only, exactly as for the global cap —
  // you need to verify a route before deciding to resume.
  if (!opts.adminRouteTest && flags["ai.paused"]) {
    throw new GateError(
      "ai_paused",
      "AI is paused by an administrator — no calls will run until it is resumed in admin settings (FR-15.12).",
    );
  }

  const globalCapUsd = flags["global_monthly_cap_usd"];
  const globalSpentUsd = await monthToDateUsd(db);
  if (!opts.adminRouteTest && globalSpentUsd >= globalCapUsd) {
    throw new GateError(
      "global_cap",
      `Global AI budget ($${globalCapUsd}) exhausted — all AI activity is paused until next month or until the cap is raised in admin settings (FR-15.10).`,
    );
  }

  const status: GateStatus = { globalSpentUsd, globalCapUsd };
  if (!userId) return status;

  // FR-2.7: while suspended, no AI spend may be incurred on the user's behalf — this
  // choke point also halts in-flight runs, mirroring ai.paused. A distinct gate tag:
  // suspension must never report as a budget condition.
  const owner = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { suspendedAt: true, suspendedReason: true },
  });
  if (owner?.suspendedAt) {
    throw new GateError(
      "user_suspended",
      `This account is suspended (${owner.suspendedReason ?? "no reason recorded"}) — no AI work will run for it until an administrator reactivates it (FR-2.7).`,
    );
  }

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
  // FR-15.12c: runs paused — no NEW run may start (user-requested included; nothing
  // bypasses this), while runs already under way continue undisturbed: assertAiAllowed
  // deliberately does not check this flag. A deliberate pause records the run as
  // `skipped` with the reason, never as `failed` — it is not an error condition.
  const flags = await getFlags(db);
  if (flags["runs.paused"]) {
    throw new SkipRunError(
      "New pipeline runs are paused by an administrator — this run was skipped; resume runs in admin settings (FR-15.12).",
      "runs_paused",
    );
  }

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
      throw new SkipRunError(
        "2 drafts already awaiting review — run skipped, reminder sent instead (FR-7.4)",
        "pending_drafts",
      );
    }
  }
  return status;
}
