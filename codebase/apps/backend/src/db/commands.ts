// Write-side helpers for pipeline runs, drafts and users (CQRS command side, AR-10.6).
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "./client";

type RunState = (typeof schema.runState.enumValues)[number];

export async function createRun(
  db: Db,
  args: {
    userId: string;
    trigger: "cron" | "manual" | "user_topic";
    profileVersion: number;
    userTopic?: { title: string; notes?: string; links?: string[] };
    workflowInstanceId?: string;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.pipelineRuns)
    .values({
      userId: args.userId,
      trigger: args.trigger,
      profileVersion: args.profileVersion,
      userTopic: args.userTopic ?? null,
      workflowInstanceId: args.workflowInstanceId ?? null,
      state: "discovering",
    })
    .returning({ id: schema.pipelineRuns.id });
  return row!;
}

/** FR-6.3/FR-7.9: proposals persisted so the app can render the angle picker and change-angle. */
export async function setRunAngleProposals(
  db: Db,
  runId: string,
  proposals: { angles: unknown[]; recommendedIndex: number },
): Promise<void> {
  await db
    .update(schema.pipelineRuns)
    .set({ angleProposals: proposals })
    .where(eq(schema.pipelineRuns.id, runId));
}

export async function setRunState(db: Db, runId: string, state: RunState, error?: string): Promise<void> {
  const terminal: RunState[] = ["published", "skipped", "rejected", "expired", "failed", "abandoned"];
  await db
    .update(schema.pipelineRuns)
    .set({
      state,
      error: error ?? null,
      ...(terminal.includes(state) ? { finishedAt: new Date() } : {}),
    })
    .where(eq(schema.pipelineRuns.id, runId));
}

export async function getUserById(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new Error(`user ${userId} not found`);
  return user;
}

/** FR-2.7: reversible suspend — profiles, drafts and history stay intact. */
export async function suspendUser(db: Db, userId: string, reason: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ suspendedAt: new Date(), suspendedReason: reason })
    .where(eq(schema.users.id, userId));
}

export async function reactivateUser(db: Db, userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(eq(schema.users.id, userId));
}

/** FR-15.8: per-user caps — row created on first change, defaults apply until then. */
export async function upsertUserLimits(
  db: Db,
  userId: string,
  patch: { monthlyCapUsd?: number; maxRunsPerDay?: number; maxReqPerMin?: number },
): Promise<void> {
  await db
    .insert(schema.userLimits)
    .values({
      userId,
      ...(patch.monthlyCapUsd != null ? { monthlyCapUsd: String(patch.monthlyCapUsd) } : {}),
      ...(patch.maxRunsPerDay != null ? { maxRunsPerDay: patch.maxRunsPerDay } : {}),
      ...(patch.maxReqPerMin != null ? { maxReqPerMin: patch.maxReqPerMin } : {}),
    })
    .onConflictDoUpdate({
      target: schema.userLimits.userId,
      set: {
        ...(patch.monthlyCapUsd != null ? { monthlyCapUsd: String(patch.monthlyCapUsd) } : {}),
        ...(patch.maxRunsPerDay != null ? { maxRunsPerDay: patch.maxRunsPerDay } : {}),
        ...(patch.maxReqPerMin != null ? { maxReqPerMin: patch.maxReqPerMin } : {}),
        updatedAt: new Date(),
      },
    });
}

/**
 * FR-2.6 right to erasure: cascade-delete every personal record; spend-ledger rows are
 * ANONYMIZED (user_id and run_id → NULL) rather than deleted, preserving accounting
 * totals. Sanity authorship needs no unassignment — both sites are single-author with
 * no author reference (FR-3.1). Published content is an editorial decision, untouched.
 *
 * Refuses a user who has app_config_audit rows: the audit is append-only (DR-9.13) and
 * its CHECK ties admin rows to a real actor — erase-vs-audit is unresolved in the docs,
 * so an admin with a config trail must be suspended instead of deleted.
 */
export async function deleteUserCascade(
  db: Db,
  userId: string,
): Promise<{ anonymizedSpendRows: number }> {
  const [auditRows] = await db
    .select({ n: count() })
    .from(schema.appConfigAudit)
    .where(eq(schema.appConfigAudit.changedBy, userId));
  if ((auditRows?.n ?? 0) > 0) {
    throw new Error(
      "This user has app_config_audit entries, which are append-only (DR-9.13) and name their acting admin. Suspend the account instead (FR-2.7), or resolve the audit-vs-erasure policy first.",
    );
  }

  let anonymized = 0;
  await db.transaction(async (tx) => {
    const runIds = (
      await tx
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.userId, userId))
    ).map((r) => r.id);
    const draftIds = (
      await tx.select({ id: schema.drafts.id }).from(schema.drafts).where(eq(schema.drafts.userId, userId))
    ).map((r) => r.id);
    const routeIds = (
      await tx.select({ id: schema.aiRoutes.id }).from(schema.aiRoutes).where(eq(schema.aiRoutes.userId, userId))
    ).map((r) => r.id);

    // spend: anonymize, never delete (totals stay; FK targets are about to go)
    const anonByUser = await tx
      .update(schema.spendLedger)
      .set({ userId: null, runId: null })
      .where(eq(schema.spendLedger.userId, userId))
      .returning({ id: schema.spendLedger.id });
    anonymized = anonByUser.length;
    if (runIds.length > 0) {
      await tx.update(schema.spendLedger).set({ runId: null }).where(inArray(schema.spendLedger.runId, runIds));
    }

    // personal records, FK leaves first
    await tx.delete(schema.gateChoices).where(eq(schema.gateChoices.userId, userId));
    if (draftIds.length > 0) {
      await tx.delete(schema.editDiffs).where(inArray(schema.editDiffs.draftId, draftIds));
      await tx.delete(schema.draftRevisions).where(inArray(schema.draftRevisions.draftId, draftIds));
      await tx.delete(schema.draftDerivatives).where(inArray(schema.draftDerivatives.draftId, draftIds));
    }
    await tx.delete(schema.drafts).where(eq(schema.drafts.userId, userId));
    await tx.delete(schema.topicCandidates).where(eq(schema.topicCandidates.userId, userId));
    if (runIds.length > 0) {
      await tx.delete(schema.pipelineRuns).where(inArray(schema.pipelineRuns.id, runIds));
    }
    await tx.delete(schema.profiles).where(eq(schema.profiles.userId, userId));
    await tx.delete(schema.onboardingSessions).where(eq(schema.onboardingSessions.userId, userId));
    await tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, userId));
    await tx.delete(schema.userLimits).where(eq(schema.userLimits.userId, userId));
    if (routeIds.length > 0) {
      await tx.delete(schema.aiHealthChecks).where(inArray(schema.aiHealthChecks.routeId, routeIds));
      await tx.delete(schema.aiRoutes).where(inArray(schema.aiRoutes.id, routeIds));
    }
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
  });
  return { anonymizedSpendRows: anonymized };
}

export async function updateDraftMarkdown(db: Db, draftId: string, markdown: string): Promise<void> {
  await db.update(schema.drafts).set({ markdown }).where(eq(schema.drafts.id, draftId));
}

export async function setDraftStatus(
  db: Db,
  draftId: string,
  status: (typeof schema.draftStatus.enumValues)[number],
): Promise<void> {
  await db.update(schema.drafts).set({ status }).where(eq(schema.drafts.id, draftId));
}

/** Afnan's site (design §8): the reviewer's public/em choice, applied at publish. */
export async function setDraftBlogType(db: Db, draftId: string, blogType: "public" | "em"): Promise<void> {
  await db.update(schema.drafts).set({ blogType }).where(eq(schema.drafts.id, draftId));
}

/** Approve-for-next-slot (FR-7.5): the hourly publisher executes at publish_at. */
export async function scheduleDraft(db: Db, draftId: string, publishAt: Date): Promise<void> {
  await db
    .update(schema.drafts)
    .set({ status: "scheduled", publishMode: "next_slot", publishAt, decidedAt: new Date() })
    .where(eq(schema.drafts.id, draftId));
}

/** Reject with category (FR-7.8); markdown purged (DR-9.11). */
export async function rejectDraft(
  db: Db,
  draftId: string,
  category: "quality" | "changed_mind" | "other",
): Promise<void> {
  await db
    .update(schema.drafts)
    .set({ status: "rejected", rejectionCategory: category, markdown: null, decidedAt: new Date() })
    .where(eq(schema.drafts.id, draftId));
}

/** Spec §5.1: the instance ended without a decision — a flag, never a status change; nothing is lost. */
export async function markDraftStale(db: Db, draftId: string): Promise<void> {
  await db.update(schema.drafts).set({ stale: true }).where(eq(schema.drafts.id, draftId));
}

/** Spec §2: any authenticated app request counts as activity. */
export async function touchLastActive(db: Db, userId: string): Promise<void> {
  await db.update(schema.users).set({ lastActiveAt: new Date() }).where(eq(schema.users.id, userId));
}

/** First open of the review screen by the owner (spec §5.2); later opens leave it alone. */
export async function markDraftSeen(db: Db, draftId: string): Promise<void> {
  await db.update(schema.drafts).set({ seenAt: new Date() }).where(and(eq(schema.drafts.id, draftId), isNull(schema.drafts.seenAt)));
}

export interface DerivativeRecord {
  kind: "hero_image" | "x" | "linkedin" | "translation";
  outcome: "produced" | "skipped" | "failed" | "declined";
  content?: string;
  assetRef?: string;
  reason?: string;
  /** Translation only: {title, excerpt, imageAlt, targetLanguage} for the publish-time second document (design §8). */
  meta?: Record<string, unknown>;
}

/**
 * DR-9.14: one row per derivative per revision. Upsert on (draft_id, kind, revision_no)
 * so a retried Workflow step overwrites its own rows instead of duplicating (AR-10.3).
 */
export async function recordDerivatives(
  db: Db,
  draftId: string,
  revisionNo: number,
  records: DerivativeRecord[],
): Promise<void> {
  for (const r of records) {
    await db
      .insert(schema.draftDerivatives)
      .values({
        draftId,
        kind: r.kind,
        outcome: r.outcome,
        content: r.content ?? null,
        assetRef: r.assetRef ?? null,
        reason: r.reason ?? null,
        meta: r.meta ?? null,
        revisionNo,
      })
      .onConflictDoUpdate({
        target: [schema.draftDerivatives.draftId, schema.draftDerivatives.kind, schema.draftDerivatives.revisionNo],
        set: {
          outcome: r.outcome,
          content: r.content ?? null,
          assetRef: r.assetRef ?? null,
          reason: r.reason ?? null,
          meta: r.meta ?? null,
          createdAt: new Date(),
        },
      });
  }
}

/** Revision instructions feed profile refinement (FR-7.9, DR-9.12). */
export async function addDraftRevision(
  db: Db,
  args: { draftId: string; revisionNo: number; instructions: string },
): Promise<void> {
  await db.insert(schema.draftRevisions).values(args);
}

/** FR-6.9: manual-edit capture. Stored as before/after JSON for now (TODO: unified diff). */
export async function addEditDiff(
  db: Db,
  args: { draftId: string; userId: string; before: string; after: string },
): Promise<void> {
  await db.insert(schema.editDiffs).values({
    draftId: args.draftId,
    userId: args.userId,
    diff: JSON.stringify({ before: args.before, after: args.after }),
  });
}

export async function createDraft(
  db: Db,
  args: {
    runId: string;
    userId: string;
    topicId: string;
    angle: unknown;
    markdown: string; // editing source-of-truth until publish (DR-9.11)
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.drafts)
    .values({
      runId: args.runId,
      userId: args.userId,
      topicId: args.topicId,
      angle: args.angle,
      markdown: args.markdown,
      status: "pending_approval",
    })
    .returning({ id: schema.drafts.id });
  return row!;
}

// ── AI route editing (FR-15.3) ────────────────────────────────────────────────────────
// Both of these exist because ai_routes has two constraints that make the obvious
// single-statement version wrong: ai_health_checks.route_id is a NOT NULL FK onto it, and
// (user_id, task_type, priority) is unique NULLS NOT DISTINCT.

/**
 * Delete a route and its health history, FK leaves first (same ordering rule as
 * deleteUserCascade). Health checks are diagnostics for a route that is about to stop
 * existing; spend_ledger and drafts.generation_meta record provider/model as plain data,
 * never as a FK, so cost history and provenance survive the delete untouched.
 */
export async function deleteRouteCascade(db: Db, routeId: string): Promise<{ healthChecksDeleted: number }> {
  let healthChecksDeleted = 0;
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.aiHealthChecks)
      .where(eq(schema.aiHealthChecks.routeId, routeId))
      .returning({ id: schema.aiHealthChecks.id });
    healthChecksDeleted = removed.length;
    await tx.delete(schema.aiRoutes).where(eq(schema.aiRoutes.id, routeId));
  });
  return { healthChecksDeleted };
}

/**
 * Renumber one task's routes to priorities 0..n-1 in the given order (0 = primary, FR-15.6).
 *
 * Two passes, because the unique index would reject an in-place swap the moment two rows
 * briefly share a priority: first park every row at a negative priority (a range the index
 * permits and no real route uses), then write the final values. One transaction, so a
 * failure can never leave routes parked.
 */
export async function reorderRoutes(db: Db, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) {
      await tx
        .update(schema.aiRoutes)
        .set({ priority: -(i + 1) })
        .where(eq(schema.aiRoutes.id, id));
    }
    for (const [i, id] of orderedIds.entries()) {
      await tx
        .update(schema.aiRoutes)
        .set({ priority: i, updatedAt: new Date() })
        .where(eq(schema.aiRoutes.id, id));
    }
  });
}

// ── Gates (spec §4) ──────────────────────────────────────────────────────────────────

/** The gate the run is waiting on — null once answered. GET /runs/:id and the answer route read it. */
export async function setRunGate(db: Db, runId: string, gate: string | null): Promise<void> {
  await db.update(schema.pipelineRuns).set({ gate }).where(eq(schema.pipelineRuns.id, runId));
}

/** Spec §4.3: every choice is copied to the preference log, with what the creator saw. */
export async function recordGateChoice(
  db: Db,
  args: { runId: string; userId: string; gate: string; optionsShown: unknown; choice: unknown; source: "user" | "auto" },
): Promise<void> {
  const freeText = typeof args.choice === "object" && args.choice && "freeText" in args.choice ? String((args.choice as { freeText: unknown }).freeText) : null;
  await db.insert(schema.gateChoices).values({
    runId: args.runId,
    userId: args.userId,
    gate: args.gate,
    optionsShown: args.optionsShown,
    choice: args.choice,
    freeText,
    source: args.source,
  });
}
