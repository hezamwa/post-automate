import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "../../src/db/client";
import { deleteRouteCascade, reorderRoutes } from "../../src/db/commands";
import { listRoutes } from "../../src/db/queries";
import { createTestDb, seedUser, type TestDb } from "./harness";

// Route editing against real Postgres, because both commands exist purely to satisfy
// constraints a mock would not have: the ai_health_checks FK and the
// (user_id, task_type, priority) unique index, NULLS NOT DISTINCT.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

async function seedChain(userId: string | null, taskType: string, models: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, model] of models.entries()) {
    const [row] = await db
      .insert(schema.aiRoutes)
      .values({ userId, taskType, priority: i, provider: "anthropic", model })
      .returning({ id: schema.aiRoutes.id });
    ids.push(row!.id);
  }
  return ids;
}

describe("deleteRouteCascade (FR-15.3)", () => {
  it("removes the route and its health history, leaving other routes alone", async () => {
    const [keep, drop] = await seedChain(null, "article", ["claude-sonnet-5", "claude-haiku-4-5"]);
    for (const routeId of [keep!, drop!]) {
      await db.insert(schema.aiHealthChecks).values({ routeId, status: "ok", latencyMs: 10, message: "OK" });
    }

    const { healthChecksDeleted } = await deleteRouteCascade(db, drop!);

    expect(healthChecksDeleted).toBe(1);
    expect(await db.select().from(schema.aiRoutes).where(eq(schema.aiRoutes.id, drop!))).toEqual([]);
    const survivors = await listRoutes(db);
    expect(survivors.map((r) => r.id)).toEqual([keep!]);
    expect(await db.select().from(schema.aiHealthChecks)).toHaveLength(1);
  });

  it("frees the priority slot so the same position can be used again", async () => {
    const [primary] = await seedChain(null, "article", ["claude-sonnet-5"]);
    await deleteRouteCascade(db, primary!);
    // Re-adding at priority 0 would violate the unique index if the row were merely disabled
    await expect(
      db.insert(schema.aiRoutes).values({
        userId: null,
        taskType: "article",
        priority: 0,
        provider: "openai",
        model: "gpt-5-mini",
      }),
    ).resolves.toBeDefined();
  });
});

describe("reorderRoutes (FR-15.6)", () => {
  it("renumbers a chain through a state where priorities would otherwise collide", async () => {
    const [a, b, c] = await seedChain(null, "article", ["model-a", "model-b", "model-c"]);

    // Promote the last to primary — every row's priority changes, and a naive in-place
    // update would briefly duplicate one.
    await reorderRoutes(db, [c!, a!, b!]);

    const rows = await listRoutes(db);
    expect(rows.map((r) => [r.model, r.priority])).toEqual([
      ["model-c", 0],
      ["model-a", 1],
      ["model-b", 2],
    ]);
  });

  it("leaves no route parked at a negative priority", async () => {
    const ids = await seedChain(null, "article", ["model-a", "model-b"]);
    await reorderRoutes(db, [ids[1]!, ids[0]!]);
    const rows = await listRoutes(db);
    expect(rows.every((r) => r.priority >= 0)).toBe(true);
  });

  it("keeps a user's chain independent of the global one with the same task", async () => {
    const userId = await seedUser(db);
    const globals = await seedChain(null, "article", ["global-primary", "global-fallback"]);
    const overrides = await seedChain(userId, "article", ["user-primary", "user-fallback"]);

    await reorderRoutes(db, [overrides[1]!, overrides[0]!]);

    const rows = await listRoutes(db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(globals[0]!)!.priority).toBe(0); // untouched
    expect(byId.get(globals[1]!)!.priority).toBe(1);
    expect(byId.get(overrides[1]!)!.priority).toBe(0); // promoted
    expect(byId.get(overrides[0]!)!.priority).toBe(1);
  });
});
