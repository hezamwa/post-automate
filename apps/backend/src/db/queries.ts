// Read-side helpers (CQRS query side, AR-10.6): drafts queue, routing config,
// route health, and the /admin/monitor snapshot (FR-15.11).
import { asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
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
      publishAt: schema.drafts.publishAt,
      createdAt: schema.drafts.createdAt,
      decidedAt: schema.drafts.decidedAt,
    })
    .from(schema.drafts)
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
      ? { state: run.state, trigger: run.trigger, angleProposals: run.angleProposals }
      : null,
  };
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
