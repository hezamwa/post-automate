// Read-side helpers (CQRS query side, AR-10.6): drafts queue, routing config,
// route health, and the /admin/monitor snapshot (FR-15.11).
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { ModelInfo } from "@post-automate/shared";
import { schema, type Db } from "./client";

/**
 * Drafts queue with each draft's derivatives at its LATEST revision (DR-9.14): the
 * review screen renders every kind separately — produced content, or why it is skipped
 * (capability off) vs failed (asked for, didn't arrive). Bodies stay in Sanity (DR-9.6).
 */
export async function listDraftsWithDerivatives(db: Db, userId: string) {
  const drafts = await db
    .select({
      id: schema.drafts.id,
      runId: schema.drafts.runId,
      status: schema.drafts.status,
      angle: schema.drafts.angle,
      sanityDocumentId: schema.drafts.sanityDocumentId,
      stale: schema.drafts.stale,
      seenAt: schema.drafts.seenAt,
      channels: schema.drafts.channels,
      publishAt: schema.drafts.publishAt,
      createdAt: schema.drafts.createdAt,
      decidedAt: schema.drafts.decidedAt,
      gate: schema.pipelineRuns.gate, // the step the run waits on — "publish" shows in the queue
    })
    .from(schema.drafts)
    .leftJoin(schema.pipelineRuns, eq(schema.pipelineRuns.id, schema.drafts.runId))
    .where(eq(schema.drafts.userId, userId))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(50);
  if (drafts.length === 0) return [];

  const rows = await db
    .select()
    .from(schema.draftDerivatives)
    .where(inArray(schema.draftDerivatives.draftId, drafts.map((d) => d.id)))
    .orderBy(desc(schema.draftDerivatives.revisionNo));
  const latestRev = new Map<string, number>();
  for (const r of rows) {
    if (!latestRev.has(r.draftId)) latestRev.set(r.draftId, r.revisionNo); // rows are rev-desc
    else latestRev.set(r.draftId, Math.max(latestRev.get(r.draftId)!, r.revisionNo));
  }
  return drafts.map((d) => ({
    ...d,
    derivatives: rows
      .filter((r) => r.draftId === d.id && r.revisionNo === (latestRev.get(d.id) ?? 0))
      .map((r) => ({
        kind: r.kind,
        outcome: r.outcome,
        content: r.content,
        assetRef: r.assetRef,
        reason: r.reason,
        revisionNo: r.revisionNo,
      })),
  }));
}

/**
 * One draft for the review screen: the markdown (the app's editing source of truth
 * until publish, DR-9.11), latest-revision derivatives (DR-9.14), and the run's state +
 * stored angle proposals for change-angle (FR-7.9). Owner-scoped (FR-2.3) — null for
 * a foreign or unknown draft, which the route maps to 404.
 */
export async function getDraftDetail(db: Db, userId: string, draftId: string) {
  const draft = await db.query.drafts.findFirst({
    where: (d, { and: andOp, eq: eqOp }) => andOp(eqOp(d.id, draftId), eqOp(d.userId, userId)),
  });
  if (!draft) return null;
  const run = await db.query.pipelineRuns.findFirst({
    where: (r, { eq: eqOp }) => eqOp(r.id, draft.runId),
  });
  // Review-screen gating: the FR-6.8 compliance checklist for medical creators, and the
  // per-draft public/em choice on Afnan's site (design §8). Both derive from data the
  // app doesn't otherwise hold.
  const owner = await db.query.users.findFirst({ where: (u, { eq: eqOp }) => eqOp(u.id, userId) });
  const active = await db.query.profiles.findFirst({
    where: (p, { and: andOp, eq: eqOp }) => andOp(eqOp(p.userId, userId), eqOp(p.status, "active")),
  });
  const medical = (active?.payload as { domain?: { field?: string } } | null)?.domain?.field === "medical";
  const rows = await db
    .select()
    .from(schema.draftDerivatives)
    .where(eq(schema.draftDerivatives.draftId, draft.id))
    .orderBy(desc(schema.draftDerivatives.revisionNo));
  const latestRev = rows[0]?.revisionNo ?? 0;
  return {
    draft: {
      id: draft.id,
      runId: draft.runId,
      status: draft.status,
      markdown: draft.markdown, // null once published/rejected/expired (purged, DR-9.11)
      angle: draft.angle,
      sanityDocumentId: draft.sanityDocumentId,
      blogType: draft.blogType,
      stale: draft.stale, // spec §5.1: revise / change_angle greyed out; approve / reject still work
      seenAt: draft.seenAt,
      channels: draft.channels,
      qualityCheck: draft.qualityCheck, // spec §3 step 8: findings shown on the review screen
      autoPublishWarnedAt: draft.autoPublishWarnedAt, // spec §5.2
      autoPublishHeldAt: draft.autoPublishHeldAt,
      publishAt: draft.publishAt,
      createdAt: draft.createdAt,
      decidedAt: draft.decidedAt,
    },
    medical, // FR-6.8: the app renders the compliance checklist before approve
    supportsBlogType: owner?.sanityProjectId === "5gz3ngjs", // design §8 (Afnan's blogPost type)
    derivatives: rows
      .filter((r) => r.revisionNo === latestRev)
      .map((r) => ({
        kind: r.kind,
        outcome: r.outcome,
        content: r.content,
        assetRef: r.assetRef,
        reason: r.reason,
        revisionNo: r.revisionNo,
      })),
    run: run
      ? { state: run.state, gate: run.gate, trigger: run.trigger, angleProposals: run.angleProposals, outline: run.outline }
      : null,
  };
}

/** Distinct creator Sanity projects — the weekly backup exports each once (NFR-16.3). */
export async function distinctSanityTargets(db: Db): Promise<{ projectId: string; dataset: string }[]> {
  const rows = await db
    .selectDistinct({ projectId: schema.users.sanityProjectId, dataset: schema.users.sanityDataset })
    .from(schema.users);
  return rows.filter((r): r is { projectId: string; dataset: string } => r.projectId != null);
}

export async function listRoutes(db: Db) {
  return db
    .select()
    .from(schema.aiRoutes)
    .orderBy(asc(schema.aiRoutes.taskType), asc(schema.aiRoutes.userId), asc(schema.aiRoutes.priority));
}

export interface RouteHealth {
  routeId: string;
  userId: string | null;
  taskType: string;
  provider: string;
  model: string;
  enabled: boolean;
  latest: { status: string; latencyMs: number | null; message: string; checkedAt: Date } | null;
}

/** Latest check per route (FR-15.5) — routes without history report latest: null. */
export async function latestHealthByRoute(db: Db): Promise<RouteHealth[]> {
  const routes = await listRoutes(db);
  const checks = await db
    .select()
    .from(schema.aiHealthChecks)
    .orderBy(desc(schema.aiHealthChecks.checkedAt))
    .limit(500);
  const latest = new Map<string, (typeof checks)[number]>();
  for (const c of checks) if (!latest.has(c.routeId)) latest.set(c.routeId, c);
  return routes.map((r) => {
    const c = latest.get(r.id);
    return {
      routeId: r.id,
      userId: r.userId,
      taskType: r.taskType,
      provider: r.provider,
      model: r.model,
      enabled: r.enabled,
      latest: c ? { status: c.status, latencyMs: c.latencyMs, message: c.message, checkedAt: c.checkedAt } : null,
    };
  });
}

export async function recentHealthChecks(db: Db, limit = 50) {
  return db.select().from(schema.aiHealthChecks).orderBy(desc(schema.aiHealthChecks.checkedAt)).limit(limit);
}

function monthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const spentUsd = sql<string>`coalesce(sum(${schema.spendLedger.estCostUsd}), 0)`;

/**
 * The /admin/monitor read model (FR-15.11, design §10): month-to-date spend broken down
 * by user / provider / task / day, per-user cap status, pipeline run + draft counts, and
 * the suspended-users list. Switch state and route health are composed in the route from
 * describeFlags() and latestHealthByRoute().
 */
export async function monitorSnapshot(db: Db) {
  const since = monthStartUtc();
  const inMonth = gte(schema.spendLedger.createdAt, since);

  const [total] = await db.select({ usd: spentUsd }).from(schema.spendLedger).where(inMonth);
  const byUser = await db
    .select({ userId: schema.spendLedger.userId, usd: spentUsd })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(schema.spendLedger.userId);
  const byProvider = await db
    .select({ provider: schema.spendLedger.provider, usd: spentUsd })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(schema.spendLedger.provider);
  const byTask = await db
    .select({ taskType: schema.spendLedger.taskType, usd: spentUsd })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(schema.spendLedger.taskType);
  const day = sql<string>`to_char(date_trunc('day', ${schema.spendLedger.createdAt}), 'YYYY-MM-DD')`;
  const byDay = await db
    .select({ day, usd: spentUsd })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(day)
    .orderBy(day);

  const users = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.users.role,
      suspendedAt: schema.users.suspendedAt,
      suspendedReason: schema.users.suspendedReason,
    })
    .from(schema.users);
  const limits = await db.select().from(schema.userLimits);
  const limitByUser = new Map(limits.map((l) => [l.userId, l]));
  const spendByUser = new Map(byUser.map((r) => [r.userId, Number(r.usd)]));

  const runsByState = await db
    .select({ state: schema.pipelineRuns.state, n: count() })
    .from(schema.pipelineRuns)
    .where(gte(schema.pipelineRuns.startedAt, since))
    .groupBy(schema.pipelineRuns.state);
  const draftsByStatus = await db
    .select({ status: schema.drafts.status, n: count() })
    .from(schema.drafts)
    .groupBy(schema.drafts.status);

  return {
    spend: {
      monthToDateUsd: Number(total?.usd ?? 0),
      byUser: byUser.map((r) => ({ userId: r.userId, usd: Number(r.usd) })), // userId null = system (canaries)
      byProvider: byProvider.map((r) => ({ provider: r.provider, usd: Number(r.usd) })),
      byTask: byTask.map((r) => ({ taskType: r.taskType, usd: Number(r.usd) })),
      byDay,
    },
    users: users.map((u) => ({
      ...u,
      // FR-15.8 defaults apply when no limits row exists (OD-16)
      monthlyCapUsd: Number(limitByUser.get(u.id)?.monthlyCapUsd ?? 10),
      spentUsd: spendByUser.get(u.id) ?? 0,
    })),
    pipeline: {
      runsThisMonth: runsByState.map((r) => ({ state: r.state, n: r.n })),
      draftsByStatus: draftsByStatus.map((r) => ({ status: r.status, n: r.n })),
    },
  };
}

/**
 * The model registry (FR-15.4), as the rest of the code wants it. Numeric columns come back
 * from pg as strings — converted here, once, so no caller ever multiplies a string by a
 * token count. A NULL price stays undefined rather than becoming 0: "unpriced" must keep
 * failing loudly at metering, not quietly cost nothing.
 */
export type ModelRow = ModelInfo & { id: string; updatedAt: Date };

export async function listModels(db: Db): Promise<ModelRow[]> {
  const rows = await db.select().from(schema.aiModels).orderBy(asc(schema.aiModels.provider), asc(schema.aiModels.model));
  return rows.map((r) => ({
    // id/updatedAt ride along for the admin surface: the pricing and validation callers
    // ignore them, and without the id the dashboard cannot address a row to edit it.
    id: r.id,
    updatedAt: r.updatedAt,
    provider: r.provider as ModelInfo["provider"],
    model: r.model,
    capability: r.capability,
    inputPerMTokUsd: r.inputPerMTokUsd == null ? undefined : Number(r.inputPerMTokUsd),
    outputPerMTokUsd: r.outputPerMTokUsd == null ? undefined : Number(r.outputPerMTokUsd),
    cachedInputPerMTokUsd: r.cachedInputPerMTokUsd == null ? undefined : Number(r.cachedInputPerMTokUsd),
    cacheWritePerMTokUsd: r.cacheWritePerMTokUsd == null ? undefined : Number(r.cacheWritePerMTokUsd),
    perImageUsd: r.perImageUsd == null ? undefined : Number(r.perImageUsd),
    perSearchUsd: r.perSearchUsd == null ? undefined : Number(r.perSearchUsd),
    notes: r.notes,
  }));
}

/** Routes pointing at a given model — a model in use may not be deleted (FR-15.4). */
export async function routesUsingModel(db: Db, provider: string, model: string) {
  return db
    .select()
    .from(schema.aiRoutes)
    .where(and(eq(schema.aiRoutes.provider, provider), eq(schema.aiRoutes.model, model)));
}

/** The run's draft (one per run) — how a gate finds what it is applying to. */
export async function getDraftByRun(db: Db, runId: string) {
  return db.query.drafts.findFirst({ where: eq(schema.drafts.runId, runId), orderBy: desc(schema.drafts.createdAt) });
}

/** The user's undecided draft, if any — the 1-pending-draft rule (spec §2, FR-7.4). */
export async function undecidedDraft(db: Db, userId: string) {
  return db.query.drafts.findFirst({
    where: and(eq(schema.drafts.userId, userId), inArray(schema.drafts.status, ["pending_approval", "revising"])),
    orderBy: desc(schema.drafts.createdAt),
  });
}

/** The run's candidates best-first, for the topic gate (spec §4.3) and GET /runs/:id. */
export async function scoredCandidates(db: Db, runId: string) {
  const rows = await db.select().from(schema.topicCandidates).where(eq(schema.topicCandidates.runId, runId));
  return rows.sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1));
}

export async function gateChoicesForRun(db: Db, runId: string) {
  return db.select().from(schema.gateChoices).where(eq(schema.gateChoices.runId, runId)).orderBy(asc(schema.gateChoices.chosenAt));
}

/** The run's fetched sources (spec §3 step 4) — the draft's grounding. */
export async function sourcesForRun(db: Db, runId: string) {
  return db.select().from(schema.sources).where(eq(schema.sources.runId, runId)).orderBy(asc(schema.sources.fetchedAt));
}

const RUN_OUTCOMES = ["published", "rejected", "abandoned", "skipped", "failed"] as const;

/**
 * GET /admin/budget breakdown (spec §8): month-to-date spend by task type, by model (with
 * cached tokens), and by run outcome — non-run spend (canaries, per-draft overrides) is
 * its own bucket — plus cost per published article, with everything that did not publish
 * attributed to the ones that did. One call answers "what did an article cost this month".
 */
export async function budgetBreakdown(db: Db) {
  const since = monthStartUtc();
  const inMonth = gte(schema.spendLedger.createdAt, since);
  const byTaskType = await db
    .select({ taskType: schema.spendLedger.taskType, usd: spentUsd, calls: count() })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(schema.spendLedger.taskType);
  const byModel = await db
    .select({
      provider: schema.spendLedger.provider,
      model: schema.spendLedger.model,
      usd: spentUsd,
      calls: count(),
      cacheReadTokens: sql<string>`coalesce(sum(${schema.spendLedger.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${schema.spendLedger.cacheWriteTokens}), 0)`,
    })
    .from(schema.spendLedger)
    .where(inMonth)
    .groupBy(schema.spendLedger.provider, schema.spendLedger.model);
  const byState = await db
    .select({ state: schema.pipelineRuns.state, usd: spentUsd })
    .from(schema.spendLedger)
    .leftJoin(schema.pipelineRuns, eq(schema.pipelineRuns.id, schema.spendLedger.runId))
    .where(inMonth)
    .groupBy(schema.pipelineRuns.state);
  const [published] = await db
    .select({ n: count() })
    .from(schema.pipelineRuns)
    .where(and(eq(schema.pipelineRuns.state, "published"), gte(schema.pipelineRuns.finishedAt, since)));

  const outcome = (state: string | null) => (state == null ? "unattributed" : (RUN_OUTCOMES as readonly string[]).includes(state) ? state : "in_progress");
  const byRunOutcome: Record<string, number> = Object.fromEntries([...RUN_OUTCOMES, "in_progress", "unattributed"].map((k) => [k, 0]));
  for (const row of byState) byRunOutcome[outcome(row.state)] = (byRunOutcome[outcome(row.state)] ?? 0) + Number(row.usd);
  const totalUsd = Object.values(byRunOutcome).reduce((a, b) => a + b, 0);
  const publishedArticles = published?.n ?? 0;
  const perArticle = (usd: number) => (publishedArticles > 0 ? Number((usd / publishedArticles).toFixed(4)) : null);

  return {
    byTaskType: byTaskType.map((r) => ({ taskType: r.taskType, usd: Number(r.usd), calls: r.calls })),
    byModel: byModel.map((r) => ({ provider: r.provider, model: r.model, usd: Number(r.usd), calls: r.calls, cacheReadTokens: Number(r.cacheReadTokens), cacheWriteTokens: Number(r.cacheWriteTokens) })),
    byRunOutcome,
    publishedArticles,
    /** all month-to-date spend ÷ published articles — rejected, abandoned, skipped and failed runs included */
    costPerPublishedArticleUsd: perArticle(totalUsd),
    /** only the spend of the runs that published — what an article costs when nothing goes wrong */
    directCostPerPublishedArticleUsd: perArticle(byRunOutcome.published ?? 0),
  };
}
