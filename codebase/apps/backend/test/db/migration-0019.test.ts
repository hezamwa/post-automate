import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./harness";

// 0019 moves auto_publish from users to user_limits (spec §5.2): the value carries over
// whether or not the user already had a limits row, and the old column is gone.

async function dbAt0018(): Promise<PGlite> {
  const client = new PGlite();
  await applyMigrations(client, { through: "0018" });
  return client;
}

async function seedUser(client: PGlite, email: string, autoPublish: boolean, withLimits: boolean): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, auto_publish) VALUES ($1, 'U', 'x', $2) RETURNING id`,
    [email, autoPublish],
  );
  const id = res.rows[0]!.id;
  if (withLimits) await client.query(`INSERT INTO user_limits (user_id) VALUES ($1)`, [id]);
  return id;
}

describe("migration 0019 — auto_publish moves to user_limits", () => {
  it("carries a true flag over, with or without an existing limits row, and drops the users column", async () => {
    const client = await dbAt0018();
    const withRow = await seedUser(client, "a@example.com", true, true);
    const noRow = await seedUser(client, "b@example.com", true, false);
    const off = await seedUser(client, "c@example.com", false, true);

    await applyMigrations(client, { from: "0019", through: "0019" });

    const rows = await client.query<{ user_id: string; auto_publish: boolean }>(`SELECT user_id, auto_publish FROM user_limits ORDER BY user_id`);
    const byUser = Object.fromEntries(rows.rows.map((r) => [r.user_id, r.auto_publish]));
    expect(byUser).toEqual({ [withRow]: true, [noRow]: true, [off]: false });
    const cols = await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`);
    expect(cols.rows.map((c) => c.column_name)).not.toContain("auto_publish");
  });
});
