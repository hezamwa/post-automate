import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { seedRun, seedUser } from "../db/harness";
import { apiEnv, call, tokenFor } from "./client";

// GET /admin/budget breakdown (spec §8, brief §6): by task, by model, by run outcome, and
// cost per published article with the non-published spend attributed — one call.
beforeEach(resetShared);

async function spend(userId: string | null, runId: string | null, taskType: string, model: string, usd: number, cache = { read: 0, write: 0 }) {
  await shared.db.insert(schema.spendLedger).values({
    userId, runId, taskType, provider: "anthropic", model, units: {}, estCostUsd: String(usd), cacheReadTokens: cache.read || null, cacheWriteTokens: cache.write || null,
  });
}

describe("GET /admin/budget", () => {
  it("answers cost per published article this month in one call", async () => {
    const { env } = apiEnv();
    const admin = await seedUser(shared.db, { role: "admin" });
    const userId = await seedUser(shared.db);
    const published1 = await seedRun(shared.db, userId, { state: "published" });
    const published2 = await seedRun(shared.db, userId, { state: "published" });
    const failed = await seedRun(shared.db, userId, { state: "failed" });
    const pending = await seedRun(shared.db, userId); // discovering → in progress
    await shared.db.update(schema.pipelineRuns).set({ finishedAt: new Date() });
    await spend(userId, published1, "article", "claude-sonnet-5", 0.5, { read: 1000, write: 200 });
    await spend(userId, published1, "scoring", "claude-haiku-4-5", 0.1);
    await spend(userId, published2, "article", "claude-sonnet-5", 0.4);
    await spend(userId, failed, "discovery", "claude-sonnet-5", 0.3);
    await spend(userId, pending, "discovery", "claude-sonnet-5", 0.2);
    await spend(null, null, "interview", "claude-haiku-4-5", 0.05); // a canary: no run

    const res = await call(env, "/admin/budget", { token: await tokenFor(admin, "admin") });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ spentUsd: 1.55, capUsd: 20 });
    const b = res.json.breakdown as Record<string, unknown>;
    expect(b.byRunOutcome).toEqual({ published: 1, rejected: 0, abandoned: 0, skipped: 0, failed: 0.3, in_progress: 0.2, unattributed: 0.05 });
    expect(b.publishedArticles).toBe(2);
    expect(b.costPerPublishedArticleUsd).toBe(0.775); // 1.55 / 2 — everything attributed
    expect(b.directCostPerPublishedArticleUsd).toBe(0.5); // 1.0 / 2 — the published runs alone
    expect(b.byTaskType).toEqual(expect.arrayContaining([{ taskType: "article", usd: 0.9, calls: 2 }, { taskType: "interview", usd: 0.05, calls: 1 }]));
    expect(b.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ model: "claude-sonnet-5", usd: 1.4, calls: 4, cacheReadTokens: 1000, cacheWriteTokens: 200 })]));
  });

  it("reports null per-article costs when nothing published yet", async () => {
    const { env } = apiEnv();
    const admin = await seedUser(shared.db, { role: "admin" });
    const b = (await call(env, "/admin/budget", { token: await tokenFor(admin, "admin") })).json.breakdown as Record<string, unknown>;
    expect(b).toMatchObject({ publishedArticles: 0, costPerPublishedArticleUsd: null, directCostPerPublishedArticleUsd: null });
  });
});
