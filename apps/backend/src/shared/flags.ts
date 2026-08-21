import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/client";

// Typed operational flag store (FR-15.14, design §10.1). app_config rows are OVERRIDES
// only — the declared set, each key's type, and its default live HERE, so an unknown or
// malformed flag cannot silently alter behaviour. Every change is audited (DR-9.13).

export const FLAGS = {
  // FR-15.12a — enforced in assertAiAllowed() (ai/gates.ts), the pre-call choke point.
  "ai.paused": { schema: z.boolean(), default: false },
  // FR-15.12b/c — declared now so the store matches design §10.1; their enforcement
  // points (publishing step, run entry) land with Phase 2, as do the /admin/flags*
  // endpoints that expose them. Until then nothing writes or reads them.
  "publishing.paused": { schema: z.boolean(), default: false },
  "runs.paused": { schema: z.boolean(), default: false },
  // NFR-11.5 global hard cap (FR-15.10) — absorbs the old getGlobalCapUsd() one-off.
  "global_monthly_cap_usd": { schema: z.number().positive(), default: 20 },
} as const;

export type FlagKey = keyof typeof FLAGS;
export type Flags = { [K in FlagKey]: z.infer<(typeof FLAGS)[K]["schema"]> };

const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

// Memoized per Db instance, which callers create per request / per Workflow step.do —
// NEVER at isolate scope (design §10.1): a warm isolate can live for minutes, and a
// cached `ai.paused: false` outliving the pause would make the stop button advisory.
// A long-parked run re-reads the switches on every step resumption, as intended.
const cache = new WeakMap<object, Promise<Flags>>();

/** One indexed read of the declared keys, validated against the declared schemas. */
export function getFlags(db: Db): Promise<Flags> {
  let flags = cache.get(db);
  if (!flags) {
    flags = readFlags(db);
    cache.set(db, flags);
  }
  return flags;
}

async function readFlags(db: Db): Promise<Flags> {
  const rows = await db
    .select()
    .from(schema.appConfig)
    .where(inArray(schema.appConfig.key, FLAG_KEYS));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<FlagKey, unknown>;
  for (const key of FLAG_KEYS) {
    const decl = FLAGS[key];
    if (!byKey.has(key)) {
      out[key] = decl.default; // no override row — normal (FR-15.14)
      continue;
    }
    const parsed = decl.schema.safeParse(byKey.get(key));
    if (parsed.success) {
      out[key] = parsed.data;
    } else {
      // A corrupt row must not become an outage: fall back to the default and warn.
      console.warn(
        `app_config['${key}'] holds a malformed value (${JSON.stringify(byKey.get(key))}); ` +
          `falling back to the default ${JSON.stringify(decl.default)} (FR-15.14)`,
      );
      out[key] = decl.default;
    }
  }
  return out as Flags;
}

/**
 * Set one flag: validates key and value against the declared set, upserts the
 * app_config override, and appends the audit row (FR-15.14, DR-9.13) — atomically,
 * so the trail can never diverge from the state it describes.
 */
export async function setFlag<K extends FlagKey>(
  db: Db,
  key: K,
  value: Flags[K],
  adminId: string,
): Promise<void> {
  const decl = FLAGS[key as FlagKey];
  if (!decl) {
    throw new Error(`Unknown flag '${key}' — the declared set lives in src/shared/flags.ts (FR-15.14)`);
  }
  const parsed = decl.schema.parse(value);
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ value: schema.appConfig.value })
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, key));
    await tx
      .insert(schema.appConfig)
      .values({ key, value: parsed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.appConfig.key,
        set: { value: parsed, updatedAt: new Date() },
      });
    await tx.insert(schema.appConfigAudit).values({
      key,
      oldValue: existing ? existing.value : null, // NULL = first write for this key
      newValue: parsed,
      changedBy: adminId,
      source: "admin",
    });
  });
  cache.delete(db); // the writer's own invocation must see its write
}

// ── Admin read models (design §7: /admin/flags, /admin/flags/audit) ──────────────────

export interface FlagActor {
  id: string;
  email: string;
  displayName: string;
}

export interface FlagChange {
  oldValue: unknown;
  newValue: unknown;
  source: "admin" | "seed" | "migration";
  changedAt: Date;
  changedBy: FlagActor | null; // null exactly when source != 'admin' (design §3)
}

export interface FlagDescription {
  key: FlagKey;
  value: Flags[FlagKey];
  default: Flags[FlagKey];
  overridden: boolean;
  lastChange: FlagChange | null;
}

async function resolveActors(db: Db, ids: string[]): Promise<Map<string, FlagActor>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Current value + default + last change (who/when) for every declared flag (FR-15.14) —
 * a switch that is on but invisible is an outage waiting to be misdiagnosed.
 */
export async function describeFlags(db: Db): Promise<FlagDescription[]> {
  const flags = await getFlags(db);
  const overrides = await db
    .select({ key: schema.appConfig.key })
    .from(schema.appConfig)
    .where(inArray(schema.appConfig.key, FLAG_KEYS));
  const overridden = new Set(overrides.map((r) => r.key));

  const audit = await db
    .select()
    .from(schema.appConfigAudit)
    .where(inArray(schema.appConfigAudit.key, FLAG_KEYS))
    .orderBy(desc(schema.appConfigAudit.changedAt));
  const latestByKey = new Map<string, (typeof audit)[number]>();
  for (const row of audit) if (!latestByKey.has(row.key)) latestByKey.set(row.key, row);
  const actors = await resolveActors(
    db,
    [...new Set([...latestByKey.values()].map((r) => r.changedBy).filter((v): v is string => !!v))],
  );

  return FLAG_KEYS.map((key) => {
    const last = latestByKey.get(key);
    return {
      key,
      value: flags[key],
      default: FLAGS[key].default,
      overridden: overridden.has(key),
      lastChange: last
        ? {
            oldValue: last.oldValue,
            newValue: last.newValue,
            source: last.source,
            changedAt: last.changedAt,
            changedBy: last.changedBy ? (actors.get(last.changedBy) ?? null) : null,
          }
        : null,
    };
  });
}

/** Change history across ALL config keys, newest first (DR-9.13) — history may include keys since removed from the declared set. */
export async function flagAudit(db: Db, limit = 100): Promise<(FlagChange & { key: string })[]> {
  const rows = await db
    .select()
    .from(schema.appConfigAudit)
    .orderBy(desc(schema.appConfigAudit.changedAt))
    .limit(limit);
  const actors = await resolveActors(db, [
    ...new Set(rows.map((r) => r.changedBy).filter((v): v is string => !!v)),
  ]);
  return rows.map((r) => ({
    key: r.key,
    oldValue: r.oldValue,
    newValue: r.newValue,
    source: r.source,
    changedAt: r.changedAt,
    changedBy: r.changedBy ? (actors.get(r.changedBy) ?? null) : null,
  }));
}
