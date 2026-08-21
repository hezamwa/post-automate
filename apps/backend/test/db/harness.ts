import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { schema } from "../../src/db/client";

// Real PostgreSQL for DB-backed tests (NFR-16.1). PGlite is the actual Postgres engine
// compiled to WASM — same SQL, same types, same constraint behaviour — so these tests
// exercise the real query planner rather than a mock, with no daemon to install.
//
// These run on the NODE pool, not the Workers pool: PGlite needs Node APIs, and the code
// under test (`gates.ts`, query handlers) is plain TS + Drizzle. Nothing about it is
// runtime-specific, so the Workers pool would add startup cost and no coverage.

const MIGRATIONS_DIR = join(import.meta.dirname, "../../drizzle");

export type TestDb = ReturnType<typeof drizzle<typeof schema>> & { $client: PGlite };

/**
 * Apply committed migrations to a PGlite instance, in order. `through`/`from` bound the
 * range by 4-digit index prefix (inclusive) so a migration test can build the pre-migration
 * schema, seed old-shape rows, then apply the migration under test on top.
 */
export async function applyMigrations(
  client: PGlite,
  opts: { through?: string; from?: string } = {},
): Promise<void> {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const idx = file.slice(0, 4);
    if (opts.from && idx < opts.from) continue;
    if (opts.through && idx > opts.through) break;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
}

/**
 * Fresh in-memory database with every committed migration applied, in order.
 * Applying the real migration files (rather than pushing the schema) means a broken
 * migration fails the test suite instead of surfacing on deploy.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await applyMigrations(client);
  const db = drizzle(client, { schema }) as TestDb;
  db.$client = client;
  return db;
}

/** Seed a user with the given limits; returns the user id. */
export async function seedUser(
  db: TestDb,
  opts: {
    email?: string;
    role?: "user" | "admin";
    monthlyCapUsd?: string;
    maxRunsPerDay?: number;
    maxReqPerMin?: number;
  } = {},
): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: opts.email ?? `user-${crypto.randomUUID()}@example.com`,
      displayName: "Test User",
      passwordHash: "pbkdf2$1$x$y",
      role: opts.role ?? "user",
      sanityProjectId: "test000",
    })
    .returning({ id: schema.users.id });
  await db.insert(schema.userLimits).values({
    userId: user!.id,
    monthlyCapUsd: opts.monthlyCapUsd ?? "10",
    maxRunsPerDay: opts.maxRunsPerDay ?? 2,
    maxReqPerMin: opts.maxReqPerMin ?? 30,
  });
  return user!.id;
}

/** Record spend against a user (or the system when userId is null). */
export async function seedSpend(
  db: TestDb,
  userId: string | null,
  estCostUsd: number,
  createdAt = new Date(),
): Promise<void> {
  await db.insert(schema.spendLedger).values({
    userId,
    taskType: "article",
    provider: "anthropic",
    model: "claude-sonnet-5",
    units: {},
    estCostUsd: String(estCostUsd),
    createdAt,
  });
}

/** Insert a pipeline run for a user (defaults to today, cron-triggered). */
export async function seedRun(
  db: TestDb,
  userId: string,
  opts: { startedAt?: Date; state?: "discovering" | "published" | "failed" } = {},
): Promise<string> {
  const [run] = await db
    .insert(schema.pipelineRuns)
    .values({
      userId,
      profileVersion: 1,
      startedAt: opts.startedAt ?? new Date(),
      state: opts.state ?? "discovering",
    })
    .returning({ id: schema.pipelineRuns.id });
  return run!.id;
}

/** Insert a draft in a given status — used to exercise the pending-drafts gate (FR-7.4). */
export async function seedDraft(
  db: TestDb,
  userId: string,
  runId: string,
  status: "pending_approval" | "revising" | "published" | "rejected" = "pending_approval",
): Promise<void> {
  await db.insert(schema.drafts).values({ userId, runId, status });
}
