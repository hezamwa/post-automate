import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { NoRouteError, runTask } from "../../src/ai/router";
import { schema } from "../../src/db/client";
import { recordDerivatives } from "../../src/db/commands";
import { dropDraftTranslation, translateDraft } from "../../src/modules/generation";
import type { Env } from "../../src/shared/env";
import { createTestDb, seedRun, seedUser, type TestDb } from "./harness";

// DR-9.14 per-derivative rows + the FR-15.13 translation case, against real Postgres.
// The env stub proves order: everything asserted here happens before provider traffic.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

async function seedDraftRow(userId: string, runId: string): Promise<string> {
  const [row] = await db
    .insert(schema.drafts)
    .values({ userId, runId, status: "pending_approval", markdown: "# hello" })
    .returning({ id: schema.drafts.id });
  return row!.id;
}

describe("recordDerivatives (DR-9.14)", () => {
  it("writes one row per kind with distinct skipped/failed reasons", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [
      { kind: "x", outcome: "produced", content: "tiny post" },
      { kind: "linkedin", outcome: "skipped", reason: "capability disabled (FR-15.13)" },
      { kind: "hero_image", outcome: "failed", reason: "provider error" },
    ]);
    const rows = await db.select().from(schema.draftDerivatives).where(eq(schema.draftDerivatives.draftId, draftId));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === "x")).toMatchObject({ outcome: "produced", content: "tiny post" });
    expect(rows.find((r) => r.kind === "linkedin")).toMatchObject({ outcome: "skipped", reason: "capability disabled (FR-15.13)" });
    expect(rows.find((r) => r.kind === "hero_image")).toMatchObject({ outcome: "failed", reason: "provider error" });
  });

  it("upserts on (draft, kind, revision) so a retried Workflow step cannot duplicate (AR-10.3)", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [{ kind: "x", outcome: "failed", reason: "first try" }]);
    await recordDerivatives(db, draftId, 0, [{ kind: "x", outcome: "produced", content: "second try" }]);
    const rows = await db.select().from(schema.draftDerivatives).where(eq(schema.draftDerivatives.draftId, draftId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "produced", content: "second try", reason: null });
  });

  it("keeps revisions apart — one row per derivative PER revision (FR-7.9)", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [{ kind: "x", outcome: "produced", content: "v0" }]);
    await recordDerivatives(db, draftId, 1, [{ kind: "x", outcome: "produced", content: "v1" }]);
    const rows = await db
      .select()
      .from(schema.draftDerivatives)
      .where(and(eq(schema.draftDerivatives.draftId, draftId), eq(schema.draftDerivatives.kind, "x")));
    expect(rows.map((r) => [r.revisionNo, r.content]).sort()).toEqual([
      [0, "v0"],
      [1, "v1"],
    ]);
  });

  it("enforces the uniqueness at the DB level, not just in code", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await db.insert(schema.draftDerivatives).values({ draftId, kind: "x", outcome: "produced", revisionNo: 0 });
    await expect(
      db.insert(schema.draftDerivatives).values({ draftId, kind: "x", outcome: "failed", revisionNo: 0 }),
    ).rejects.toThrow(/draft_derivatives_draft_kind_rev|duplicate/i);
  });
});

describe("router NoRouteError (FR-15.13)", () => {
  it("is thrown, typed and naming the task, when no enabled route exists", async () => {
    const userId = await seedUser(db);
    const err = await runTask({} as Env, db, {
      taskType: "translate",
      userId,
      input: { messages: [{ role: "user", content: "x" }] },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRouteError);
    expect((err as NoRouteError).taskType).toBe("translate");
    expect((err as NoRouteError).message).toMatch(/task 'translate'/);
  });

  it("ignores disabled routes — disabling the last route disables the capability", async () => {
    const userId = await seedUser(db);
    await db.insert(schema.aiRoutes).values({
      userId: null,
      taskType: "translate",
      priority: 0,
      provider: "anthropic",
      model: "claude-sonnet-5",
      enabled: false, // FR-15.3 per-route disable
    });
    await expect(
      runTask({} as Env, db, { taskType: "translate", userId, input: { messages: [] } }),
    ).rejects.toThrow(NoRouteError);
  });
});

describe("translateDraft — per-draft override, unroutable case (FR-6.14, FR-15.13)", () => {
  it("records a FAILED translation row with the reason instead of dropping the request", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);

    const result = await translateDraft({} as Env, db, {
      draftId,
      runId,
      userId,
      markdown: "# hello",
      targetLanguage: "ar",
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/no enabled route/);
    expect(result.revisionNo).toBe(0);

    const rows = await db.select().from(schema.draftDerivatives).where(eq(schema.draftDerivatives.draftId, draftId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "translation", outcome: "failed", revisionNo: 0 });
  });

  it("lands on the draft's CURRENT derivative revision and replaces its own prior attempt", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    // simulate a revised draft: derivatives recorded for revisions 0 and 1
    await recordDerivatives(db, draftId, 0, [{ kind: "x", outcome: "produced", content: "v0" }]);
    await recordDerivatives(db, draftId, 1, [{ kind: "x", outcome: "produced", content: "v1" }]);

    const first = await translateDraft({} as Env, db, { draftId, runId, userId, markdown: "# hi", targetLanguage: "ar" });
    expect(first.revisionNo).toBe(1);
    const second = await translateDraft({} as Env, db, { draftId, runId, userId, markdown: "# hi", targetLanguage: "ar" });
    expect(second.revisionNo).toBe(1); // upsert — re-requesting replaces, never duplicates

    const translations = await db
      .select()
      .from(schema.draftDerivatives)
      .where(and(eq(schema.draftDerivatives.draftId, draftId), eq(schema.draftDerivatives.kind, "translation")));
    expect(translations).toHaveLength(1);
  });
});

describe("currentProducedTranslation — the publish-time staleness guard (design §8)", () => {
  const META = { title: "عنوان", excerpt: "ملخص", imageAlt: "وصف", targetLanguage: "ar" };

  it("returns the translation only when produced at the draft's CURRENT revision", async () => {
    const { currentProducedTranslation } = await import("../../src/modules/publishing");
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [
      { kind: "translation", outcome: "produced", content: "# مرحبا", meta: META },
    ]);
    expect(await currentProducedTranslation(db, draftId)).toMatchObject({
      markdown: "# مرحبا",
      meta: { targetLanguage: "ar" },
    });
  });

  it("never publishes a STALE earlier-revision translation after a revision replaced the set", async () => {
    const { currentProducedTranslation } = await import("../../src/modules/publishing");
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [
      { kind: "translation", outcome: "produced", content: "old translation", meta: META },
    ]);
    // revision 1 re-derived without a translation surviving (failed, or user dropped it)
    await recordDerivatives(db, draftId, 1, [{ kind: "x", outcome: "produced", content: "v1" }]);
    expect(await currentProducedTranslation(db, draftId)).toBeNull();
  });

  it("ignores failed rows and rows without meta", async () => {
    const { currentProducedTranslation } = await import("../../src/modules/publishing");
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [
      { kind: "translation", outcome: "failed", reason: "no route" },
    ]);
    expect(await currentProducedTranslation(db, draftId)).toBeNull();
  });
});

describe("dropDraftTranslation (FR-6.14 DELETE)", () => {
  it("removes the current revision's translation and reports absence honestly", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    const draftId = await seedDraftRow(userId, runId);
    await recordDerivatives(db, draftId, 0, [{ kind: "translation", outcome: "produced", content: "مرحبا" }]);

    expect(await dropDraftTranslation(db, draftId)).toBe(true);
    expect(await dropDraftTranslation(db, draftId)).toBe(false); // already gone
    const rows = await db.select().from(schema.draftDerivatives).where(eq(schema.draftDerivatives.draftId, draftId));
    expect(rows).toHaveLength(0);
  });
});
