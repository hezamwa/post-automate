import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { profileSchema, profileSchemaV1 } from "@post-automate/shared";
import { schema } from "../../src/db/client";
import { techProfile } from "../fixtures";
import { applyMigrations, type TestDb } from "./harness";

// 0003 backfill (design §4 "Schema evolution", DR-9.15): v1 payloads — the `language`
// enum — are rewritten to the explicit primaryLanguage + translation pair, hard-coded
// per the 2026-08-21 decision for the two known creators, and the migration must FAIL
// LOUDLY on any row that decision does not cover. These tests build the pre-0003 schema,
// seed old-shape rows, then apply 0003 on top — exercising the committed SQL itself.

/** The old payload shape, derived from the current fixture and kept honest via profileSchemaV1. */
function v1Payload(language: "ar" | "en" | "bilingual") {
  const { primaryLanguage: _p, translation: _t, ...common } = techProfile();
  return profileSchemaV1.parse({ ...common, language });
}

async function dbAt0002(): Promise<TestDb> {
  const client = new PGlite();
  await applyMigrations(client, { through: "0002" });
  const db = drizzle(client, { schema }) as TestDb;
  db.$client = client;
  return db;
}

async function seedV1Profile(
  db: TestDb,
  sanityProjectId: string,
  payload: Record<string, unknown>,
  status: "draft" | "active" = "active",
): Promise<string> {
  // Raw SQL throughout: the drizzle schema describes the CURRENT shape (later-migration
  // columns included), which does not exist yet on a pre-0003 database.
  const res = await db.$client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, sanity_project_id)
     VALUES ($1, 'Migration Test User', 'pbkdf2$1$x$y', $2) RETURNING id`,
    [`user-${crypto.randomUUID()}@example.com`, sanityProjectId],
  );
  const userId = res.rows[0]!.id;
  await db.$client.query(
    `INSERT INTO profiles (user_id, version, status, payload) VALUES ($1, 1, $2, $3)`,
    [userId, status, JSON.stringify(payload)],
  );
  return userId;
}

describe("migration 0003 — profile language split (FR-3.7, FR-3.13, DR-9.15)", () => {
  it("rewrites a known creator's v1 'en' payload to the decided answer and stamps schema v2", async () => {
    const db = await dbAt0002();
    const userId = await seedV1Profile(db, "r9zdt0s0", v1Payload("en"));

    await applyMigrations(db.$client, { from: "0003" });

    const row = await db.query.profiles.findFirst({
      where: eq(schema.profiles.userId, userId),
    });
    expect(row?.schemaVersion).toBe(2);
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.language).toBeUndefined();
    expect(payload.primaryLanguage).toBe("en");
    expect(payload.translation).toEqual({ enabled: false });
    expect(profileSchema.safeParse(payload).success).toBe(true);
  });

  it("rewrites a 'bilingual' draft row the same way — hard-coded decision, not derivation", async () => {
    // Mirrors staging: the second creator's draft profile says "bilingual", which never
    // recorded WHICH language was primary. The decision (design §4) is en + translation off.
    const db = await dbAt0002();
    const userId = await seedV1Profile(db, "5gz3ngjs", v1Payload("bilingual"), "draft");

    await applyMigrations(db.$client, { from: "0003" });

    const row = await db.query.profiles.findFirst({
      where: eq(schema.profiles.userId, userId),
    });
    expect(row?.schemaVersion).toBe(2);
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.primaryLanguage).toBe("en");
    expect(payload.translation).toEqual({ enabled: false });
    expect(row?.status).toBe("draft"); // status untouched
  });

  it("fails loudly on a profile row whose user the decision does not cover", async () => {
    const db = await dbAt0002();
    await seedV1Profile(db, "someother", v1Payload("en"));

    await expect(applyMigrations(db.$client, { from: "0003" })).rejects.toThrow(
      /no primaryLanguage decision/,
    );
  });

  it("fails loudly on a known creator's row that does not carry the v1 shape", async () => {
    const db = await dbAt0002();
    const { language: _l, ...payloadWithoutLanguage } = v1Payload("en");
    await seedV1Profile(db, "r9zdt0s0", payloadWithoutLanguage);

    await expect(applyMigrations(db.$client, { from: "0003" })).rejects.toThrow(
      /no primaryLanguage decision/,
    );
  });

  it("applies cleanly on an empty database — fresh environments seed v2 directly", async () => {
    const db = await dbAt0002();
    await expect(applyMigrations(db.$client, { from: "0003" })).resolves.toBeUndefined();
  });
});
