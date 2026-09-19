import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { draftReminders, isReminderDay } from "../../src/cron/reminders";
import { env, seedDraftRow, startRun } from "../workflow/harness";

// Draft reminders (spec §5): day 6, then weekly, no expiry; muted only when the creator
// opened the draft in the last day AND has been in the app today.
beforeEach(resetShared);

const DAY = 24 * 3600_000;
const now = new Date("2026-09-20T06:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

describe("isReminderDay", () => {
  it("fires on day 6, then every 7 days, forever", () => {
    expect([0, 1, 5, 6, 7, 12, 13, 20, 27, 90].map(isReminderDay)).toEqual([false, false, false, true, false, false, true, true, true, true]);
  });
});

describe("draftReminders", () => {
  it("nudges pending drafts on their reminder day, with a deep link, and leaves others alone", async () => {
    const six = await startRun();
    await seedDraftRow(six, { createdAt: daysAgo(6) });
    const thirteen = await startRun();
    await seedDraftRow(thirteen, { createdAt: daysAgo(13), stale: true });
    const young = await startRun();
    await seedDraftRow(young, { createdAt: daysAgo(3) });
    const decided = await startRun();
    await seedDraftRow(decided, { createdAt: daysAgo(6), status: "published", markdown: null });

    expect(await draftReminders(env, shared.db, now)).toBe(2);
    expect(shared.pushes.map((p) => [p.title, p.data?.runId])).toEqual([
      ["Draft waiting for your review", six.runId],
      ["Draft waiting for your review", thirteen.runId],
    ]);
    expect(shared.pushes[1]?.body).toContain("13 days");
  });

  it("stays quiet when the creator opened the draft in the last day AND is in the app today", async () => {
    const params = await startRun();
    await seedDraftRow(params, { createdAt: daysAgo(6), seenAt: daysAgo(0.5) });
    await shared.db.update(schema.users).set({ lastActiveAt: daysAgo(0.1) }).where(eq(schema.users.id, params.userId));
    expect(await draftReminders(env, shared.db, now)).toBe(0);
  });

  it("still nudges when only one of the two mute conditions holds", async () => {
    const seenButAway = await startRun();
    await seedDraftRow(seenButAway, { createdAt: daysAgo(6), seenAt: daysAgo(0.5) }); // seen, but not active today
    const activeButUnseen = await startRun();
    await seedDraftRow(activeButUnseen, { createdAt: daysAgo(6) });
    await shared.db.update(schema.users).set({ lastActiveAt: daysAgo(0.1) }).where(eq(schema.users.id, activeButUnseen.userId));
    expect(await draftReminders(env, shared.db, now)).toBe(2);
  });
});
