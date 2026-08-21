// Seed: users, per-user limits, the active tech profile, global default AI routes
// (FR-2.1, FR-15.3, design §12 Phase 1).
// Idempotent — upserts by natural keys; re-run any time. Run: pnpm db:seed
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq, isNull, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PROFILE_SCHEMA_VERSION, type Profile } from "@post-automate/shared";
import { DEFAULT_ROUTES } from "../src/ai/registry";
import * as schema from "../src/db/schema";
import { hashPassword } from "../src/shared/password";
import { AFNAN_PROFILE, WALEED_PROFILE } from "./profiles";

const here = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(here, "..", ".dev.vars"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const env = loadDevVars();
const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set (in env or .dev.vars)");

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql, { schema });

async function seedUser(input: {
  email: string;
  displayName: string;
  role: "user" | "admin";
  sanityProjectId: string;
}) {
  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, input.email),
  });
  if (existing) {
    console.log(`user exists: ${input.email} (${existing.id})`);
    return existing.id;
  }
  const tempPassword = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
  const [row] = await db
    .insert(schema.users)
    .values({
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      sanityProjectId: input.sanityProjectId,
      sanityDataset: "production",
      autoPublish: false, // approval for everyone initially (OD-4); medical stays false forever (FR-7.2)
      passwordHash: await hashPassword(tempPassword),
    })
    .returning({ id: schema.users.id });
  console.log(`user created: ${input.email} (${row!.id})`);
  console.log(`  TEMP PASSWORD (shown once — save it to your password manager): ${tempPassword}`);
  return row!.id;
}

/** Profiles are append-only (FR-3.10): seed only if the user has NO versions at all. */
async function seedProfile(userId: string, payload: Profile) {
  const existing = await db.query.profiles.findFirst({
    where: eq(schema.profiles.userId, userId),
  });
  if (existing) {
    console.log(`profile exists for ${userId} (v${existing.version}, ${existing.status}) — not touching it`);
    return;
  }
  await db.insert(schema.profiles).values({
    userId,
    version: 1,
    status: "active",
    payload,
    schemaVersion: PROFILE_SCHEMA_VERSION, // DR-9.15
  });
  console.log(`profile v1 (active, schema v${PROFILE_SCHEMA_VERSION}) created for ${userId}`);
}

async function main() {
  // 1. Users (FR-2.1: data, not code). Afnan joins in Phase 2.
  const waleedId = await seedUser({
    email: "hezamwa@gmail.com",
    displayName: "Waleed AlHezam",
    role: "admin", // FR-2.5 — also the admin
    sanityProjectId: "r9zdt0s0",
  });

  // 2. Per-user limits (FR-15.8 defaults: $10/month, 2 runs/day, 30 req/min)
  await db.insert(schema.userLimits).values({ userId: waleedId }).onConflictDoNothing();
  console.log("user_limits ensured for", waleedId);

  // 2b. Hand-written tech profile with explicit primaryLanguage + translation
  // (FR-3.7/3.13, design §12 Phase 1)
  await seedProfile(waleedId, WALEED_PROFILE);

  // 2c. The medical user (design §12 Phase 2): guardrails ride on the compliance block;
  // auto_publish is FALSE and must stay so (FR-7.2)
  const afnanId = await seedUser({
    email: "afnan@afnanalmass.sa",
    displayName: "Dr. Afnan Almass",
    role: "user",
    sanityProjectId: "5gz3ngjs",
  });
  await db.insert(schema.userLimits).values({ userId: afnanId }).onConflictDoNothing();
  await seedProfile(afnanId, AFNAN_PROFILE);

  // 3. Global default AI routes (FR-15.3; design §6.4) — user_id NULL, priority 0
  let inserted = 0;
  for (const r of DEFAULT_ROUTES) {
    const priority = r.priority ?? 0;
    const exists = await db.query.aiRoutes.findFirst({
      where: and(
        isNull(schema.aiRoutes.userId),
        eq(schema.aiRoutes.taskType, r.taskType),
        eq(schema.aiRoutes.priority, priority),
      ),
    });
    if (exists) continue;
    await db.insert(schema.aiRoutes).values({
      userId: null,
      taskType: r.taskType,
      priority,
      provider: r.provider,
      model: r.model,
      params: {},
      enabled: true,
      version: 1,
    });
    inserted++;
  }
  console.log(`ai_routes: ${inserted} inserted, ${DEFAULT_ROUTES.length - inserted} already present`);

  // No app_config seeding: rows are OVERRIDES only — every flag's default (incl. the
  // $20 global cap, NFR-11.5) lives in src/shared/flags.ts, and a missing row is
  // normal (FR-15.14). Overrides are written via setFlag so they land in the audit.

  console.log("\nSeed complete.");
  await sql.end();
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message);
  process.exit(1);
});
