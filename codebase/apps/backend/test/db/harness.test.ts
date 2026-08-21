import { describe, expect, it } from "vitest";
import { schema } from "../../src/db/client";
import { createTestDb, seedUser } from "./harness";

describe("test harness", () => {
  it("applies every committed migration cleanly", async () => {
    const db = await createTestDb();
    const tables = await db.$client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = tables.rows.map((r) => r.table_name);
    // spot-check the tables the gates read, so a dropped migration fails loudly here
    expect(names).toEqual(expect.arrayContaining(["users", "user_limits", "spend_ledger", "pipeline_runs", "drafts"]));
  });

  it("seeds a user with limits", async () => {
    const db = await createTestDb();
    const userId = await seedUser(db, { monthlyCapUsd: "5" });
    const limits = await db.query.userLimits.findFirst();
    expect(limits?.userId).toBe(userId);
    expect(Number(limits?.monthlyCapUsd)).toBe(5);
  });

  it("isolates databases between tests", async () => {
    const db = await createTestDb();
    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(0);
  });
});
