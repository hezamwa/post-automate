import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../../src/db/client";
import { describeFlags, flagAudit, FLAGS, getFlags, setFlag } from "../../src/shared/flags";
import { createTestDb, seedUser, type TestDb } from "./harness";

// Typed flag store (FR-15.14, DR-9.13, design §10.1): declared set with defaults in
// code, app_config rows as overrides, every change audited. These are the operational
// kill switches — a wrong answer here is either a stop button that doesn't stop or an
// outage from a corrupt row, so both directions are pinned down.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A second Db handle over the same database — a "next invocation" as far as the cache is concerned. */
function nextInvocation(current: TestDb): TestDb {
  const fresh = drizzle(current.$client, { schema }) as TestDb;
  fresh.$client = current.$client;
  return fresh;
}

describe("getFlags — defaults and overrides (FR-15.14)", () => {
  it("returns the declared defaults when no rows exist — a missing row is normal", async () => {
    const flags = await getFlags(db);
    expect(flags["ai.paused"]).toBe(false);
    expect(flags["publishing.paused"]).toBe(false);
    expect(flags["runs.paused"]).toBe(false);
    expect(flags["global_monthly_cap_usd"]).toBe(20); // NFR-11.5
    expect(FLAGS["global_monthly_cap_usd"].default).toBe(20);
  });

  it("applies app_config overrides on top of the defaults", async () => {
    await db.insert(schema.appConfig).values([
      { key: "ai.paused", value: true },
      { key: "global_monthly_cap_usd", value: 50 },
    ]);
    const flags = await getFlags(db);
    expect(flags["ai.paused"]).toBe(true);
    expect(flags["global_monthly_cap_usd"]).toBe(50);
    expect(flags["runs.paused"]).toBe(false); // untouched keys keep their defaults
  });

  it("falls back to the default and warns on a malformed stored value — never throws", async () => {
    // A corrupt row must not become an outage (design §10.1).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.insert(schema.appConfig).values([
      { key: "ai.paused", value: "definitely" },
      { key: "global_monthly_cap_usd", value: -5 }, // cap must be positive
    ]);
    const flags = await getFlags(db);
    expect(flags["ai.paused"]).toBe(false);
    expect(flags["global_monthly_cap_usd"]).toBe(20);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/malformed/);
  });

  it("ignores app_config rows outside the declared set", async () => {
    await db.insert(schema.appConfig).values({ key: "mystery.knob", value: 42 });
    await expect(getFlags(db)).resolves.toBeDefined();
  });

  it("memoizes per Db instance only — the next invocation re-reads (design §10.1)", async () => {
    // A warm isolate caching `ai.paused: false` past the pause would make the stop
    // button advisory. Db handles are created per request / per Workflow step, so
    // per-instance memoization == per-invocation freshness.
    expect((await getFlags(db))["ai.paused"]).toBe(false);
    await db.insert(schema.appConfig).values({ key: "ai.paused", value: true });
    expect((await getFlags(db))["ai.paused"]).toBe(false); // same handle: cached
    expect((await getFlags(nextInvocation(db)))["ai.paused"]).toBe(true); // next: fresh
  });
});

describe("setFlag — validated writes with an audit trail (FR-15.14, DR-9.13)", () => {
  it("writes the override and appends an audit row (old NULL on first write)", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    await setFlag(db, "ai.paused", true, adminId);

    const [config] = await db
      .select()
      .from(schema.appConfig)
      .where(eq(schema.appConfig.key, "ai.paused"));
    expect(config?.value).toBe(true);

    const audits = await db.select().from(schema.appConfigAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      key: "ai.paused",
      oldValue: null, // no prior row
      newValue: true,
      changedBy: adminId,
      source: "admin",
    });
  });

  it("records the previous value on subsequent writes — the trail accumulates", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    await setFlag(db, "global_monthly_cap_usd", 50, adminId);
    await setFlag(db, "global_monthly_cap_usd", 30, adminId);

    const audits = await db
      .select()
      .from(schema.appConfigAudit)
      .where(eq(schema.appConfigAudit.key, "global_monthly_cap_usd"));
    expect(audits).toHaveLength(2);
    expect(audits.some((a) => a.oldValue === null && a.newValue === 50)).toBe(true);
    expect(audits.some((a) => a.oldValue === 50 && a.newValue === 30)).toBe(true);
    expect((await getFlags(nextInvocation(db)))["global_monthly_cap_usd"]).toBe(30);
  });

  it("is visible to the writer's own invocation immediately", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    await getFlags(db); // prime the cache
    await setFlag(db, "ai.paused", true, adminId);
    expect((await getFlags(db))["ai.paused"]).toBe(true);
  });

  it("rejects an unknown key at write time and writes nothing", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    // @ts-expect-error — the type system already forbids this; the runtime must too
    await expect(setFlag(db, "ai.pasued", true, adminId)).rejects.toThrow(/Unknown flag/);
    expect(await db.select().from(schema.appConfig)).toHaveLength(0);
    expect(await db.select().from(schema.appConfigAudit)).toHaveLength(0);
  });

  it("rejects a value that fails the declared schema and writes nothing", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    // @ts-expect-error — deliberately malformed
    await expect(setFlag(db, "ai.paused", "yes", adminId)).rejects.toThrow();
    await expect(setFlag(db, "global_monthly_cap_usd", -1, adminId)).rejects.toThrow();
    expect(await db.select().from(schema.appConfig)).toHaveLength(0);
    expect(await db.select().from(schema.appConfigAudit)).toHaveLength(0);
  });
});

describe("describeFlags — the admin visibility read model (FR-15.14)", () => {
  it("lists every declared flag with value, default, and no change history when untouched", async () => {
    const flags = await describeFlags(db);
    expect(flags.map((f) => f.key).sort()).toEqual(Object.keys(FLAGS).sort());
    const ai = flags.find((f) => f.key === "ai.paused")!;
    expect(ai).toMatchObject({ value: false, default: false, overridden: false, lastChange: null });
  });

  it("shows the override AND who set it, when — a switch that is on but invisible is an outage", async () => {
    const adminId = await seedUser(db, { role: "admin", email: "ops@example.com" });
    await setFlag(db, "ai.paused", true, adminId);
    const ai = (await describeFlags(nextInvocation(db))).find((f) => f.key === "ai.paused")!;
    expect(ai.value).toBe(true);
    expect(ai.overridden).toBe(true);
    expect(ai.lastChange).toMatchObject({
      oldValue: null,
      newValue: true,
      source: "admin",
      changedBy: { id: adminId, email: "ops@example.com" },
    });
  });

  it("reports the LATEST change when a flag was set more than once", async () => {
    const adminId = await seedUser(db, { role: "admin" });
    await setFlag(db, "global_monthly_cap_usd", 50, adminId);
    await setFlag(db, "global_monthly_cap_usd", 30, adminId);
    const cap = (await describeFlags(nextInvocation(db))).find((f) => f.key === "global_monthly_cap_usd")!;
    expect(cap.value).toBe(30);
    expect(cap.lastChange).toMatchObject({ oldValue: 50, newValue: 30 });
  });
});

describe("flagAudit — full change history, newest first (DR-9.13)", () => {
  it("returns every change with its actor resolved", async () => {
    const adminId = await seedUser(db, { role: "admin", email: "ops2@example.com" });
    await setFlag(db, "runs.paused", true, adminId);
    await setFlag(db, "runs.paused", false, adminId);
    const audit = await flagAudit(db);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ key: "runs.paused", newValue: false, oldValue: true });
    expect(audit[1]).toMatchObject({ key: "runs.paused", newValue: true, oldValue: null });
    expect(audit[0]?.changedBy?.email).toBe("ops2@example.com");
  });
});

describe("app_config_audit invariants (DR-9.13, design §3)", () => {
  it("enforces changed_by NULL exactly when source != 'admin' at the DB level", async () => {
    const userId = await seedUser(db);
    // admin without an actor: rejected
    await expect(
      db.insert(schema.appConfigAudit).values({ key: "k", newValue: 1, source: "admin" }),
    ).rejects.toThrow(/app_config_audit_actor|check/i);
    // seed WITH an actor: rejected — seeds have no acting admin
    await expect(
      db
        .insert(schema.appConfigAudit)
        .values({ key: "k", newValue: 1, source: "seed", changedBy: userId }),
    ).rejects.toThrow(/app_config_audit_actor|check/i);
    // the two valid shapes
    await expect(
      db.insert(schema.appConfigAudit).values({ key: "k", newValue: 1, source: "seed" }),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(schema.appConfigAudit)
        .values({ key: "k", newValue: 2, source: "admin", changedBy: userId }),
    ).resolves.toBeDefined();
  });
});
