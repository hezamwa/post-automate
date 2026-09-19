import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { dailyDispatch } from "../../src/cron/dispatch";
import { apiEnv } from "../api/client";
import { techProfile } from "../fixtures";
import { seedCreator, seedDraftRow, startRun } from "../workflow/harness";

// The daily dispatcher (spec §2): a scheduled run needs ALL of autoRun, activity within 7
// days, today in preferredDays, and no undecided draft. Anyone failing one gets nothing.
beforeEach(resetShared);

const DAY = 24 * 3600_000;
const monday = new Date("2026-09-21T06:00:00Z"); // a Monday
const daysAgo = (n: number) => new Date(monday.getTime() - n * DAY);

async function creator(overrides: Parameters<typeof techProfile>[0] = {}, lastActiveAt: Date | null = daysAgo(1)) {
  const userId = await seedCreator(techProfile({ autoRun: true, cadence: { postsPerWeek: 2, preferredDays: ["mon", "thu"], preferredHourUtc: 9 }, ...overrides }));
  await shared.db.update(schema.users).set({ lastActiveAt }).where(eq(schema.users.id, userId));
  return userId;
}

describe("dailyDispatch", () => {
  it("launches a cron run for an opted-in, active creator on a preferred day with nothing pending", async () => {
    const { env, pipeline } = apiEnv();
    const userId = await creator();
    const { launched, skipped } = await dailyDispatch(env, shared.db, monday);
    expect(launched).toHaveLength(1);
    expect(skipped).toEqual([]);
    expect(pipeline.instances.has(launched[0]!)).toBe(true);
    const run = await shared.db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, launched[0]!) });
    expect(run).toMatchObject({ userId, trigger: "cron", workflowInstanceId: launched[0] });
  });

  it("launches nothing for everyone else, naming the condition that failed", async () => {
    const { env, pipeline } = apiEnv();
    const off = await creator({ autoRun: false });
    const quiet = await creator({}, daysAgo(8));
    const never = await creator({}, null); // measured from account creation: created just now → active, but…
    await shared.db.update(schema.users).set({ createdAt: daysAgo(30) }).where(eq(schema.users.id, never));
    const offDay = await creator({ cadence: { postsPerWeek: 1, preferredDays: ["thu"], preferredHourUtc: 9 } });
    const busy = await creator();
    await seedDraftRow(await startRun().then((p) => ({ ...p, userId: busy })), { status: "pending_approval" });

    const { launched, skipped } = await dailyDispatch(env, shared.db, monday);
    expect(launched).toEqual([]);
    expect(pipeline.instances.size).toBe(0);
    expect(Object.fromEntries(skipped)).toMatchObject({
      [off]: "autoRun off",
      [quiet]: "inactive for 7 days",
      [never]: "inactive for 7 days",
      [offDay]: "not a preferred day (mon)",
      [busy]: "a draft is undecided",
    });
  });

  it("a creator without an active profile is skipped quietly", async () => {
    const { env } = apiEnv();
    const [user] = await shared.db.insert(schema.users).values({ email: "noprofile@example.com", displayName: "N", passwordHash: "x" }).returning({ id: schema.users.id });
    const { skipped } = await dailyDispatch(env, shared.db, monday);
    expect(skipped).toEqual([[user!.id, expect.stringContaining("No ACTIVE profile")]]);
  });
});
