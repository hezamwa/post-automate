import { beforeEach, describe, expect, it } from "vitest";
import { assertAiAllowed, assertRunnable, GateError, SkipRunError } from "../../src/ai/gates";
import { schema } from "../../src/db/client";
import { reactivateUser, suspendUser } from "../../src/db/commands";
import { createTestDb, seedDraft, seedRun, seedSpend, seedUser, type TestDb } from "./harness";

// Design §10 layers 2–3. These gates are the only thing standing between a scheduling bug
// and an exhausted API budget, so every refusal path is asserted — including the message,
// which FR-15.8/15.10 require to be human-readable rather than a silent skip.
let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

// getGlobalCapUsd folded into the typed flag store (design §10.1) — its default and
// override behaviour is asserted directly in flags.test.ts; here the override is
// asserted through the gate itself so a regression in either layer still fails.
describe("assertAiAllowed — ai.paused kill switch (FR-15.12a)", () => {
  it("refuses every call while paused, with the gate named and a human-readable reason", async () => {
    const userId = await seedUser(db); // well under every cap — the switch alone refuses
    await db.insert(schema.appConfig).values({ key: "ai.paused", value: true });
    await assertAiAllowed(db, userId).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).gate).toBe("ai_paused");
        expect((e as GateError).message).toMatch(/AI is paused by an administrator/);
      },
    );
  });

  it("refuses system calls too — health canaries stop as well", async () => {
    await db.insert(schema.appConfig).values({ key: "ai.paused", value: true });
    await expect(assertAiAllowed(db, null)).rejects.toThrow(/AI is paused/);
  });

  it("halts a run already in flight at its gates step", async () => {
    // The switch lives in the pre-call gate, not run entry (design §10.1): a parked
    // run re-reads it on resumption and stops even mid-pipeline.
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await db.insert(schema.appConfig).values({ key: "ai.paused", value: true });
    await expect(assertRunnable(db, userId, { runId })).rejects.toThrow(/AI is paused/);
  });

  it("lets an explicitly admin-triggered route test through, exactly like the cap bypass", async () => {
    // You need to verify a route before deciding to resume (design §10.1).
    await db.insert(schema.appConfig).values({ key: "ai.paused", value: true });
    await seedSpend(db, null, 25); // paused AND over the global cap
    await expect(assertAiAllowed(db, null, { adminRouteTest: true })).resolves.toBeDefined();
  });
});

describe("assertAiAllowed — per-user suspend (FR-2.7)", () => {
  it("refuses AI work for a suspended user, tagged as an account state — never a budget condition", async () => {
    const userId = await seedUser(db); // no spend at all — suspension alone refuses
    await suspendUser(db, userId, "requested a pause");
    await assertAiAllowed(db, userId).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).gate).toBe("user_suspended");
        expect((e as GateError).message).toMatch(/suspended \(requested a pause\)/);
        expect((e as GateError).message).not.toMatch(/budget/i);
      },
    );
  });

  it("blocks a run from starting while suspended, and again after reactivation it runs", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await suspendUser(db, userId, "hold");
    await expect(assertRunnable(db, userId, { runId })).rejects.toThrow(/suspended/);
    await reactivateUser(db, userId);
    await expect(assertRunnable(db, userId, { runId })).resolves.toBeDefined();
  });

  it("does not affect system calls or other users", async () => {
    const suspended = await seedUser(db);
    const other = await seedUser(db);
    await suspendUser(db, suspended, "hold");
    await expect(assertAiAllowed(db, null)).resolves.toBeDefined();
    await expect(assertAiAllowed(db, other)).resolves.toBeDefined();
  });
});

describe("assertRunnable — runs.paused kill switch (FR-15.12c)", () => {
  it("SKIPS a new run with the reason — a deliberate pause is not a failure", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await db.insert(schema.appConfig).values({ key: "runs.paused", value: true });
    await assertRunnable(db, userId, { runId }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(SkipRunError);
        expect((e as SkipRunError).kind).toBe("runs_paused"); // pauses send NO FR-7.4 reminder
        expect((e as SkipRunError).message).toMatch(/runs are paused by an administrator/);
      },
    );
  });

  it("blocks user-requested runs too — nothing bypasses it", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await db.insert(schema.appConfig).values({ key: "runs.paused", value: true });
    await expect(assertRunnable(db, userId, { runId, userRequested: true })).rejects.toThrow(SkipRunError);
  });

  it("leaves runs already under way undisturbed — their AI calls still pass", async () => {
    // The design's whole point (§10.1): runs.paused stops NEW runs at entry only;
    // assertAiAllowed, which in-flight steps call, must not check it.
    const userId = await seedUser(db);
    await db.insert(schema.appConfig).values({ key: "runs.paused", value: true });
    await expect(assertAiAllowed(db, userId)).resolves.toBeDefined();
  });
});

describe("assertAiAllowed — global cap (FR-15.10)", () => {
  it("enforces an admin-overridden cap from app_config", async () => {
    const userId = await seedUser(db, { monthlyCapUsd: "1000" });
    await db.insert(schema.appConfig).values({ key: "global_monthly_cap_usd", value: 5 });
    await seedSpend(db, userId, 5);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(/Global AI budget \(\$5\)/);
  });

  it("allows a call when spend is below the cap", async () => {
    const userId = await seedUser(db);
    await seedSpend(db, userId, 5);
    const status = await assertAiAllowed(db, userId);
    expect(status.globalSpentUsd).toBeCloseTo(5, 10);
    expect(status.globalCapUsd).toBe(20);
  });

  it("refuses everything once global spend reaches the cap", async () => {
    const userId = await seedUser(db, { monthlyCapUsd: "1000" });
    await seedSpend(db, userId, 20);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(GateError);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(/Global AI budget/);
  });

  it("counts system spend (userId null) toward the global cap", async () => {
    // health canaries bill to no user but still consume the budget
    const userId = await seedUser(db, { monthlyCapUsd: "1000" });
    await seedSpend(db, null, 20);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(/Global AI budget/);
  });

  it("lets an admin-triggered route test through a hit cap", async () => {
    // Sole documented bypass (design §10 layer 2) — you need it to verify a route
    // before deciding whether to raise the cap.
    const userId = await seedUser(db, { monthlyCapUsd: "1000" });
    await seedSpend(db, null, 25);
    await expect(assertAiAllowed(db, null, { adminRouteTest: true })).resolves.toBeDefined();
    expect((await assertAiAllowed(db, userId, { adminRouteTest: true })).globalSpentUsd).toBeCloseTo(25, 10);
  });

  it("ignores spend from previous months", async () => {
    const userId = await seedUser(db);
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 15);
    await seedSpend(db, userId, 999, lastMonth);
    await expect(assertAiAllowed(db, userId)).resolves.toBeDefined();
  });
});

describe("assertAiAllowed — per-user gates (FR-15.8)", () => {
  it("refuses once the user reaches their monthly cap", async () => {
    const userId = await seedUser(db, { monthlyCapUsd: "10" });
    await seedSpend(db, userId, 10);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(/Monthly AI budget \(\$10\)/);
  });

  it("does not let one user's spend gate another", async () => {
    const spender = await seedUser(db);
    const other = await seedUser(db);
    await seedSpend(db, spender, 10);
    await expect(assertAiAllowed(db, other)).resolves.toBeDefined();
  });

  it("refuses when the per-minute rate limit is reached", async () => {
    const userId = await seedUser(db, { maxReqPerMin: 3 });
    for (let i = 0; i < 3; i++) await seedSpend(db, userId, 0.001);
    await expect(assertAiAllowed(db, userId)).rejects.toThrow(/Rate limit reached \(3 AI calls\/minute\)/);
  });

  it("does not count calls older than a minute toward the rate limit", async () => {
    const userId = await seedUser(db, { maxReqPerMin: 2 });
    await seedSpend(db, userId, 0.001, hoursAgo(1));
    await seedSpend(db, userId, 0.001, hoursAgo(1));
    await expect(assertAiAllowed(db, userId)).resolves.toBeDefined();
  });

  it("skips per-user gates entirely for system calls", async () => {
    await expect(assertAiAllowed(db, null)).resolves.toMatchObject({ globalSpentUsd: 0 });
  });

  it("applies documented defaults when a user has no limits row", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: "nolimits@example.com", displayName: "N", passwordHash: "x", sanityProjectId: "p" })
      .returning({ id: schema.users.id });
    await seedSpend(db, user!.id, 10); // default cap is $10 (OD-16)
    await expect(assertAiAllowed(db, user!.id)).rejects.toThrow(/Monthly AI budget \(\$10\)/);
  });
});

describe("assertRunnable — run-level gates", () => {
  it("allows a first run of the day", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId })).resolves.toBeDefined();
  });

  it("does not count the current run against the daily limit", async () => {
    // the run row exists before the gate step executes — it must exclude itself
    const userId = await seedUser(db, { maxRunsPerDay: 1 });
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId })).resolves.toBeDefined();
  });

  it("refuses once the daily run limit is reached (FR-15.8)", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 2 });
    await seedRun(db, userId);
    await seedRun(db, userId);
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId })).rejects.toThrow(/Daily run limit reached \(2\/day\)/);
  });

  it("counts only today's runs toward the daily limit", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 1 });
    await seedRun(db, userId, { startedAt: hoursAgo(48) });
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId })).resolves.toBeDefined();
  });

  it("SKIPS rather than fails when 2 drafts already await review (FR-7.4, OD-19)", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 10 });
    const prior = await seedRun(db, userId);
    await seedDraft(db, userId, prior, "pending_approval");
    await seedDraft(db, userId, prior, "revising");
    const runId = await seedRun(db, userId);
    // A skip is not a failure — DR-9.4 records it as `skipped`, and the user gets a
    // reminder push instead of a new draft (kind drives the FR-7.4 reminder).
    await assertRunnable(db, userId, { runId }).then(
      () => {
        throw new Error("expected a skip");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(SkipRunError);
        expect((e as SkipRunError).kind).toBe("pending_drafts");
      },
    );
  });

  it("lets a user-requested run past the pending-drafts gate (FR-7.7)", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 10 });
    const prior = await seedRun(db, userId);
    await seedDraft(db, userId, prior, "pending_approval");
    await seedDraft(db, userId, prior, "pending_approval");
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId, userRequested: true })).resolves.toBeDefined();
  });

  it("never lets a user-requested run past the budget cap (FR-7.7)", async () => {
    const userId = await seedUser(db, { monthlyCapUsd: "10" });
    await seedSpend(db, userId, 10);
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId, userRequested: true })).rejects.toThrow(GateError);
  });

  it("ignores resolved drafts when counting pending ones", async () => {
    const userId = await seedUser(db, { maxRunsPerDay: 10 });
    const prior = await seedRun(db, userId);
    await seedDraft(db, userId, prior, "published");
    await seedDraft(db, userId, prior, "rejected");
    const runId = await seedRun(db, userId);
    await expect(assertRunnable(db, userId, { runId })).resolves.toBeDefined();
  });

  it("tags each refusal with the gate that fired", async () => {
    const userId = await seedUser(db, { monthlyCapUsd: "1" });
    await seedSpend(db, userId, 1);
    const runId = await seedRun(db, userId);
    await assertRunnable(db, userId, { runId }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(GateError);
      expect((e as GateError).gate).toBe("user_cap");
    });
    expect.assertions(2);
  });
});
