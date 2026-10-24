import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { nudgeSilentCreators } from "../../src/cron/nudges";
import { env, seedCreator, seedDraftRow, startRun } from "../workflow/harness";

// The silence nudge (spec §2): 7 days without an app request and no pending draft → one
// push, then at most weekly.
beforeEach(resetShared);

const DAY = 24 * 3600_000;
const now = new Date("2026-09-20T06:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

async function creatorSeen(lastActiveAt: Date | null, extra: Partial<typeof schema.users.$inferInsert> = {}) {
  const userId = await seedCreator();
  await shared.db.update(schema.users).set({ lastActiveAt, ...extra }).where(eq(schema.users.id, userId));
  return userId;
}

describe("nudgeSilentCreators", () => {
  it("nudges after 7 quiet days, once, and records it", async () => {
    const userId = await creatorSeen(daysAgo(9));
    expect(await nudgeSilentCreators(env, shared.db, now)).toBe(1);
    expect(shared.pushes[0]).toMatchObject({ title: "Anything to write this week?", body: expect.stringContaining("9 days"), data: { action: "generate" } });
    expect((await shared.db.query.users.findFirst({ where: eq(schema.users.id, userId) }))?.lastNudgedAt).toEqual(now);
    // the next day: nothing — weekly at most
    expect(await nudgeSilentCreators(env, shared.db, new Date(now.getTime() + DAY))).toBe(0);
    // a week later: again
    expect(await nudgeSilentCreators(env, shared.db, new Date(now.getTime() + 7 * DAY))).toBe(1);
  });

  it("leaves active creators, creators with a pending draft, admins and suspended accounts alone", async () => {
    await creatorSeen(daysAgo(2));
    const pending = await creatorSeen(daysAgo(20));
    await seedDraftRow({ ...(await startRun()), userId: pending }, { status: "pending_approval" });
    await creatorSeen(daysAgo(20), { role: "admin" });
    await creatorSeen(daysAgo(20), { suspendedAt: daysAgo(1) });
    expect(await nudgeSilentCreators(env, shared.db, now)).toBe(0);
  });
});
