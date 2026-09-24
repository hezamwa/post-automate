import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { remindExpiringConnections } from "../../src/cron/social-expiry";
import { env, seedCreator } from "../workflow/harness";

// FR-18.7: one reconnect push for a connection with no refresh token that expires within
// 7 days; never for one that can refresh itself (X), never twice.
beforeEach(resetShared);

const DAY = 86_400_000;
const now = new Date("2026-09-24T06:00:00Z");

async function connection(provider: "x" | "linkedin", expiresInDays: number, refresh = false) {
  const userId = await seedCreator();
  await shared.db.insert(schema.socialAccounts).values({
    userId,
    provider,
    accountId: "id",
    handle: "h",
    accessTokenEnc: "v1:x",
    refreshTokenEnc: refresh ? "v1:r" : null,
    expiresAt: new Date(now.getTime() + expiresInDays * DAY),
  });
  return userId;
}

describe("remindExpiringConnections", () => {
  it("pushes once for LinkedIn within 7 days, not for later expiry or a refreshable X", async () => {
    const soon = await connection("linkedin", 5);
    await connection("linkedin", 20);
    await connection("x", 0.05, true);
    expect(await remindExpiringConnections(env, shared.db, now)).toBe(1);
    expect(shared.pushes[0]).toMatchObject({ title: "Reconnect LinkedIn", body: expect.stringContaining("5 days"), data: { action: "reconnect", provider: "linkedin" } });
    const row = await shared.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.userId, soon) });
    expect(row?.expiryRemindedAt).toEqual(now);
    expect(await remindExpiringConnections(env, shared.db, new Date(now.getTime() + DAY))).toBe(0);
  });
});
