import { exportPKCS8, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "../../src/db/client";
import { resetFcmTokenCache } from "../../src/shared/fcm";
import { maybeBudgetAlerts, notifyAdmins, notifyUser } from "../../src/shared/notify";
import type { Env } from "../../src/shared/env";
import { createTestDb, seedUser, type TestDb } from "./harness";

// Push fan-out (FR-7.1, FR-15.11) with the FCM HTTP boundary faked — real users table,
// real token lookups, recorded outbound calls. The fake fetcher answers the OAuth
// exchange and records every messages:send.

let env: Env;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  env = {
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "test-project",
      client_email: "worker@test-project.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
    }),
  } as Env;
});

let db: TestDb;
let sends: { url: string; body: Record<string, unknown> }[];
let fakeFetch: typeof fetch;

beforeEach(async () => {
  db = await createTestDb();
  resetFcmTokenCache();
  sends = [];
  fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "test-bearer", expires_in: 3600 }), { status: 200 });
    }
    sends.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

async function withToken(userId: string, token: string) {
  await db.update(schema.users).set({ fcmToken: token }).where(eq(schema.users.id, userId));
}

describe("notifyUser (FR-7.1)", () => {
  it("delivers to the user's registered device with title, body and deep-link data", async () => {
    const userId = await seedUser(db);
    await withToken(userId, "device-abc");
    const ok = await notifyUser(env, db, userId, { title: "Draft ready", body: "T", data: { draftId: "d1" } }, fakeFetch);
    expect(ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(sends[0]?.body).toEqual({
      message: { token: "device-abc", notification: { title: "Draft ready", body: "T" }, data: { draftId: "d1" } },
    });
  });

  it("returns false and sends nothing when the user has no token — never throws", async () => {
    const userId = await seedUser(db);
    expect(await notifyUser(env, db, userId, { title: "x", body: "y" }, fakeFetch)).toBe(false);
    expect(sends).toHaveLength(0);
  });
});

describe("notifyAdmins (FR-15.11)", () => {
  it("delivers to every admin WITH a device, skipping users and token-less admins", async () => {
    const admin1 = await seedUser(db, { role: "admin" });
    await seedUser(db, { role: "admin" }); // no token
    const user = await seedUser(db);
    await withToken(admin1, "admin-1");
    await withToken(user, "user-1"); // not an admin — must not receive
    expect(await notifyAdmins(env, db, { title: "alert", body: "b" }, fakeFetch)).toBe(1);
    expect(sends).toHaveLength(1);
    expect((sends[0]?.body as { message: { token: string } }).message.token).toBe("admin-1");
  });
});

describe("maybeBudgetAlerts (FR-15.10/15.11)", () => {
  it("pushes to admins when a call crosses a global threshold", async () => {
    const admin = await seedUser(db, { role: "admin" });
    await withToken(admin, "admin-1");
    await maybeBudgetAlerts(
      env,
      db,
      { gate: { globalSpentUsd: 15.9, globalCapUsd: 20 }, costUsd: 0.2, userId: null },
      fakeFetch,
    );
    expect(sends).toHaveLength(1);
    const note = (sends[0]?.body as { message: { notification: { title: string } } }).message.notification;
    expect(note.title).toBe("Global AI budget at 80%");
  });

  it("pushes to the user and admins on a per-user crossing; silent when nothing crossed", async () => {
    const admin = await seedUser(db, { role: "admin" });
    const userId = await seedUser(db);
    await withToken(admin, "admin-1");
    await withToken(userId, "user-1");
    await maybeBudgetAlerts(
      env,
      db,
      { gate: { globalSpentUsd: 1, globalCapUsd: 20, userSpentUsd: 9.9, userCapUsd: 10 }, costUsd: 0.2, userId },
      fakeFetch,
    );
    const tokens = sends.map((s) => (s.body as { message: { token: string } }).message.token).sort();
    expect(tokens).toEqual(["admin-1", "user-1"]);

    sends = [];
    await maybeBudgetAlerts(
      env,
      db,
      { gate: { globalSpentUsd: 1, globalCapUsd: 20, userSpentUsd: 2, userCapUsd: 10 }, costUsd: 0.1, userId },
      fakeFetch,
    );
    expect(sends).toHaveLength(0);
  });
});
