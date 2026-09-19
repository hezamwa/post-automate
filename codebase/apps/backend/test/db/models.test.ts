import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { routeRejection } from "@post-automate/shared";
import { DEFAULT_ROUTES } from "../../src/ai/registry";
import { schema } from "../../src/db/client";
import { listModels, routesUsingModel } from "../../src/db/queries";
import { createTestDb, type TestDb } from "./harness";

// The registry is a table now (migration 0010), so these run against the real one: the seed
// is part of the migration, and getting it wrong would invalidate every route on deploy.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

describe("ai_models seed (migration 0010)", () => {
  it("carries the models that used to live in code", async () => {
    const models = await listModels(db);
    const keys = models.map((m) => `${m.provider}/${m.model}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "anthropic/claude-sonnet-5",
        "anthropic/claude-haiku-4-5",
        "openai/gpt-image-1",
        "openai/gpt-4.1-mini",
        "openai/gpt-5-mini",
        "grok/grok-4",
      ]),
    );
  });

  it("no longer carries brave, retired in migration 0011", async () => {
    // brave was a registry row for an adapter stub that threw on every call. Tavily replaces
    // it on the two-step search path; leaving the row would offer a provider that cannot run.
    const models = await listModels(db);
    expect(models.find((m) => m.provider === "brave")).toBeUndefined();
  });

  it("refuses to retire a provider a route still points at", async () => {
    // Migration 0011's guard, exercised against real Postgres: the DO block raises rather
    // than leaving a live route aimed at a provider that no longer exists in the enum.
    await db.insert(schema.aiRoutes).values({
      userId: null, taskType: "web_search", priority: 0, provider: "brave", model: "brave-web-search",
    });
    await expect(
      db.execute(sql`DO $chk$
        DECLARE stray record;
        BEGIN
          SELECT r.id INTO stray FROM ai_routes r WHERE r.provider = 'brave' LIMIT 1;
          IF FOUND THEN RAISE EXCEPTION 'ai_routes still points at brave'; END IF;
          DELETE FROM ai_models WHERE provider = 'brave';
        END $chk$;`),
    ).rejects.toThrow(/still points at brave/);
  });

  it("reads prices back as numbers, and an absent price as undefined", async () => {
    const models = await listModels(db);
    const sonnet = models.find((m) => m.model === "claude-sonnet-5")!;
    // numeric columns arrive from pg as strings; a string here would multiply into nonsense
    expect(sonnet.inputPerMTokUsd).toBe(3);
    expect(sonnet.outputPerMTokUsd).toBe(15);
    expect(typeof sonnet.inputPerMTokUsd).toBe("number");

    const grok = models.find((m) => m.model === "grok-4")!;
    expect(grok.inputPerMTokUsd).toBeUndefined(); // not 0 — "unknown" must keep failing loudly
  });

  it("carries the row id, which the dashboard needs to edit or remove a model", async () => {
    // Regression: listModels used to return only the pricing projection. The admin view
    // asserts its own response type over the wire, so nothing caught the missing id until
    // every row rendered as if it were being edited (id undefined === undefined).
    for (const m of await listModels(db)) {
      expect(m.id).toEqual(expect.any(String));
      expect(m.updatedAt).toBeInstanceOf(Date);
    }
  });

  it("validates every seeded default route against the seeded registry", async () => {
    // The two seeds must agree: a default route the registry refuses is a route nobody
    // could recreate from the dashboard after deleting it (FR-15.3/15.4).
    const models = await listModels(db);
    const rejected = DEFAULT_ROUTES.map((r) => ({
      route: `${r.taskType} → ${r.provider}/${r.model}`,
      reason: routeRejection(models, r.provider, r.model, r.taskType),
    })).filter((r) => r.reason !== null);
    expect(rejected).toEqual([]);
  });

  it("enforces one row per provider/model", async () => {
    await expect(
      db.insert(schema.aiModels).values({ provider: "anthropic", model: "claude-sonnet-5", capability: "chat" }),
    ).rejects.toThrow();
  });
});

describe("routesUsingModel (FR-15.4)", () => {
  it("finds the routes that would break if a model were removed", async () => {
    await db.insert(schema.aiRoutes).values({
      userId: null,
      taskType: "article",
      priority: 0,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(await routesUsingModel(db, "anthropic", "claude-sonnet-5")).toHaveLength(1);
    expect(await routesUsingModel(db, "anthropic", "claude-haiku-4-5")).toHaveLength(0);
  });
});
