// Bounded context: profiles (AR-10.2). Versioned, append-only (FR-3.10).
import { and, desc, eq } from "drizzle-orm";
import { PROFILE_SCHEMA_VERSION, profileSchema, type Profile } from "@post-automate/shared";
import { schema, type Db } from "../../db/client";

export async function getActiveProfile(
  db: Db,
  userId: string,
): Promise<{ version: number; profile: Profile }> {
  const row = await db.query.profiles.findFirst({
    where: and(eq(schema.profiles.userId, userId), eq(schema.profiles.status, "active")),
    orderBy: desc(schema.profiles.version),
  });
  if (!row) {
    throw new Error(`No ACTIVE profile for user ${userId} — seed or confirm one first (FR-3.10)`);
  }
  // DR-9.15: a payload is only parseable against the shape version it was written with.
  // The 0003 backfill left exactly one shape in the DB, so a mismatch means a pending
  // migration — name that, rather than surfacing it as a Zod validation failure.
  if (row.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `Profile v${row.version} for user ${userId} carries payload schema v${row.schemaVersion}; ` +
        `this build reads v${PROFILE_SCHEMA_VERSION} — run the pending drizzle migrations (DR-9.15)`,
    );
  }
  return { version: row.version, profile: profileSchema.parse(row.payload) };
}

/** Append a new profile version (never mutate, FR-3.10) and activate it. */
export async function createProfileVersion(
  db: Db,
  userId: string,
  payload: Profile,
): Promise<{ id: string; version: number }> {
  const latest = await db.query.profiles.findFirst({
    where: eq(schema.profiles.userId, userId),
    orderBy: desc(schema.profiles.version),
  });
  const version = (latest?.version ?? 0) + 1;
  await db
    .update(schema.profiles)
    .set({ status: "superseded" })
    .where(and(eq(schema.profiles.userId, userId), eq(schema.profiles.status, "active")));
  const [row] = await db
    .insert(schema.profiles)
    .values({
      userId,
      version,
      status: "active",
      payload: profileSchema.parse(payload),
      schemaVersion: PROFILE_SCHEMA_VERSION, // DR-9.15: stamp the shape, never rely on the column default
    })
    .returning({ id: schema.profiles.id });
  return { id: row!.id, version };
}
