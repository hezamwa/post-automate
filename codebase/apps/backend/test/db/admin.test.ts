import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testRoute } from "../../src/ai/health";
import { schema } from "../../src/db/client";
import {
  deleteUserCascade,
  recordDerivatives,
  suspendUser,
  upsertUserLimits,
} from "../../src/db/commands";
import { latestHealthByRoute, monitorSnapshot } from "../../src/db/queries";
import { setFlag } from "../../src/shared/flags";
import type { Env } from "../../src/shared/env";
import { createTestDb, seedDraft, seedRun, seedSpend, seedUser, type TestDb } from "./harness";

// Admin-surface services against real Postgres: the FR-2.6 erasure cascade (the FK web
// makes ordering a genuine correctness risk), the FR-15.5 canary, and the FR-15.11
// monitor read model. The provider adapter is mocked at its boundary — never the DB.

vi.mock("../../src/ai/adapters", () => ({
  getAdapter: vi.fn(() => ({
    id: "anthropic",
    capabilities: ["chat"],
    healthCheck: vi.fn(async () => ({ status: "ok", latencyMs: 812, message: "OK — model responded." })),
  })),
}));

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

async function seedRoute(userId: string | null, taskType = "article"): Promise<string> {
  const [row] = await db
    .insert(schema.aiRoutes)
    .values({ userId, taskType, priority: 0, provider: "anthropic", model: "claude-sonnet-5" })
    .returning({ id: schema.aiRoutes.id });
  return row!.id;
}

describe("deleteUserCascade (FR-2.6)", () => {
  it("erases every personal record, anonymizes spend, and leaves other users untouched", async () => {
    const target = await seedUser(db);
    const bystander = await seedUser(db);

    // full personal graph for the target
    await db.insert(schema.profiles).values({ userId: target, version: 1, status: "active", payload: {}, schemaVersion: 2 });
    await db.insert(schema.onboardingSessions).values({ userId: target });
    const runId = await seedRun(db, target);
    const [candidate] = await db
      .insert(schema.topicCandidates)
      .values({ runId, userId: target, title: "t", summary: "s" })
      .returning({ id: schema.topicCandidates.id });
    const [draft] = await db
      .insert(schema.drafts)
      .values({ userId: target, runId, topicId: candidate!.id, markdown: "# x" })
      .returning({ id: schema.drafts.id });
    await recordDerivatives(db, draft!.id, 0, [{ kind: "x", outcome: "produced", content: "post" }]);
    await db.insert(schema.draftRevisions).values({ draftId: draft!.id, revisionNo: 1, instructions: "shorter" });
    await db.insert(schema.editDiffs).values({ draftId: draft!.id, userId: target, diff: "{}" });
    await db.insert(schema.refreshTokens).values({ userId: target, tokenHash: "h", expiresAt: new Date() });
    await seedSpend(db, target, 3);
    const routeId = await seedRoute(target);
    await db.insert(schema.aiHealthChecks).values({ routeId, status: "ok", message: "OK" });
    await seedSpend(db, bystander, 5);

    const { anonymizedSpendRows } = await deleteUserCascade(db, target);
    expect(anonymizedSpendRows).toBe(1);

    // every personal table is empty for the target; the user row itself is gone
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, target) })).toBeUndefined();
    for (const [table, col] of [
      [schema.profiles, schema.profiles.userId],
      [schema.drafts, schema.drafts.userId],
      [schema.pipelineRuns, schema.pipelineRuns.userId],
      [schema.topicCandidates, schema.topicCandidates.userId],
      [schema.refreshTokens, schema.refreshTokens.userId],
      [schema.userLimits, schema.userLimits.userId],
      [schema.aiRoutes, schema.aiRoutes.userId],
    ] as const) {
      expect(await db.select().from(table).where(eq(col, target))).toHaveLength(0);
    }

    // spend anonymized, not deleted: the row survives with no user and no run
    const orphaned = await db.select().from(schema.spendLedger);
    expect(orphaned).toHaveLength(2);
    const anon = orphaned.filter((r) => r.userId === null);
    expect(anon).toHaveLength(1);
    expect(anon[0]?.runId).toBeNull();
    expect(Number(anon[0]?.estCostUsd)).toBe(3); // accounting preserved

    // bystander untouched
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, bystander) })).toBeDefined();
    expect(orphaned.some((r) => r.userId === bystander)).toBe(true);
  });

  it("refuses a user with app_config_audit entries — the audit is append-only (DR-9.13)", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    await setFlag(db, "ai.paused", true, adminId);
    await expect(deleteUserCascade(db, adminId)).rejects.toThrow(/app_config_audit.*Suspend/s);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, adminId) })).toBeDefined();
  });
});

describe("testRoute (FR-15.5)", () => {
  it("stores and returns the human-readable result with latency", async () => {
    const routeId = await seedRoute(null);
    const result = await testRoute({} as Env, db, routeId);
    expect(result).toMatchObject({
      routeId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      status: "ok",
      message: "OK — model responded in 812 ms.",
    });
    const stored = await db.select().from(schema.aiHealthChecks).where(eq(schema.aiHealthChecks.routeId, routeId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.message).toBe("OK — model responded in 812 ms.");
  });

  it("returns null for an unknown route", async () => {
    expect(await testRoute({} as Env, db, crypto.randomUUID())).toBeNull();
  });
});

describe("primaryRouteFailedTwice (FR-15.6)", () => {
  it("fires only after two consecutive non-ok checks", async () => {
    const { primaryRouteFailedTwice } = await import("../../src/ai/health");
    const routeId = await seedRoute(null);
    expect(await primaryRouteFailedTwice(db, routeId)).toBe(false); // no history
    await db.insert(schema.aiHealthChecks).values({ routeId, status: "timeout", message: "t", checkedAt: new Date(Date.now() - 2000) });
    expect(await primaryRouteFailedTwice(db, routeId)).toBe(false); // one failure
    await db.insert(schema.aiHealthChecks).values({ routeId, status: "provider_error", message: "p", checkedAt: new Date(Date.now() - 1000) });
    expect(await primaryRouteFailedTwice(db, routeId)).toBe(true); // two in a row
    await db.insert(schema.aiHealthChecks).values({ routeId, status: "ok", message: "OK" });
    expect(await primaryRouteFailedTwice(db, routeId)).toBe(false); // recovery resets the streak
  });
});

describe("latestHealthByRoute (FR-15.5)", () => {
  it("reports the newest check per route, and null for never-tested routes", async () => {
    const tested = await seedRoute(null, "article");
    const untested = await seedRoute(null, "translate");
    await db.insert(schema.aiHealthChecks).values({ routeId: tested, status: "timeout", message: "old", checkedAt: new Date(Date.now() - 60_000) });
    await db.insert(schema.aiHealthChecks).values({ routeId: tested, status: "ok", message: "new" });
    const health = await latestHealthByRoute(db);
    expect(health.find((h) => h.routeId === tested)?.latest).toMatchObject({ status: "ok", message: "new" });
    expect(health.find((h) => h.routeId === untested)?.latest).toBeNull();
  });
});

describe("monitorSnapshot (FR-15.11)", () => {
  it("aggregates month-to-date spend by user, applies cap defaults, and lists suspension state", async () => {
    const a = await seedUser(db, { monthlyCapUsd: "15" });
    const b = await seedUser(db);
    await seedSpend(db, a, 4);
    await seedSpend(db, a, 1);
    await seedSpend(db, b, 2);
    await seedSpend(db, null, 0.5); // system spend (canaries) counts in the total
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 15);
    await seedSpend(db, a, 99, lastMonth); // outside the window
    await suspendUser(db, b, "on hold");
    const runId = await seedRun(db, a);
    await seedDraft(db, a, runId, "pending_approval");

    const snap = await monitorSnapshot(db);
    expect(snap.spend.monthToDateUsd).toBeCloseTo(7.5, 6);
    expect(snap.spend.byUser.find((r) => r.userId === a)?.usd).toBeCloseTo(5, 6);
    expect(snap.spend.byUser.find((r) => r.userId === null)?.usd).toBeCloseTo(0.5, 6);
    expect(snap.spend.byTask).toEqual([{ taskType: "article", usd: expect.any(Number) }]);

    const userA = snap.users.find((u) => u.id === a)!;
    expect(userA.monthlyCapUsd).toBe(15);
    expect(userA.spentUsd).toBeCloseTo(5, 6);
    const userB = snap.users.find((u) => u.id === b)!;
    expect(userB.suspendedAt).not.toBeNull();
    expect(userB.suspendedReason).toBe("on hold");

    expect(snap.pipeline.runsThisMonth).toEqual([{ state: "discovering", n: 1 }]);
    expect(snap.pipeline.draftsByStatus).toEqual([{ status: "pending_approval", n: 1 }]);
  });
});

describe("distinctSanityTargets (NFR-16.3)", () => {
  it("returns each creator project once, skipping users without one", async () => {
    const { distinctSanityTargets } = await import("../../src/db/queries");
    await seedUser(db); // harness default: test000/production
    await seedUser(db); // same project — must not duplicate
    await db.insert(schema.users).values({
      email: `np-${crypto.randomUUID()}@example.com`,
      displayName: "No Project",
      passwordHash: "x",
      sanityProjectId: null,
    });
    const targets = await distinctSanityTargets(db);
    expect(targets).toEqual([{ projectId: "test000", dataset: "production" }]);
  });
});

describe("upsertUserLimits (FR-15.8)", () => {
  it("patches only the provided fields and creates the row on first change", async () => {
    const userId = await seedUser(db); // harness seeds a limits row with defaults
    await upsertUserLimits(db, userId, { monthlyCapUsd: 25 });
    let row = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, userId) });
    expect(Number(row?.monthlyCapUsd)).toBe(25);
    expect(row?.maxRunsPerDay).toBe(2); // untouched
    await upsertUserLimits(db, userId, { maxRunsPerDay: 5 });
    row = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, userId) });
    expect(Number(row?.monthlyCapUsd)).toBe(25); // still 25
    expect(row?.maxRunsPerDay).toBe(5);
  });
});
