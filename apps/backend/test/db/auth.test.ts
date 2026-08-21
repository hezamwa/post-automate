import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, login, refresh } from "../../src/auth/service";
import { consumeRefreshToken, issueRefreshToken, verifyAccessToken } from "../../src/auth/tokens";
import { schema } from "../../src/db/client";
import { reactivateUser, suspendUser } from "../../src/db/commands";
import { hashPassword } from "../../src/shared/password";
import { createTestDb, type TestDb } from "./harness";

// Login/refresh flows against real Postgres (FR-2.2, FR-2.7). The suspension paths
// matter most: a suspended account must be refused with a human-readable reason at
// login AND refresh — history intact, reactivation restoring everything (FR-2.7).

const SECRET = "test-signing-key-0123456789abcdef";

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

async function seedCredentialedUser(
  opts: { email?: string; password?: string; role?: "user" | "admin" } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? `auth-${crypto.randomUUID()}@example.com`;
  const password = opts.password ?? "correct horse battery staple";
  const [row] = await db
    .insert(schema.users)
    .values({
      email,
      displayName: "Auth Test User",
      passwordHash: await hashPassword(password),
      role: opts.role ?? "user",
      sanityProjectId: "test000",
    })
    .returning({ id: schema.users.id });
  return { id: row!.id, email, password };
}

describe("login (FR-2.2)", () => {
  it("returns a token pair and the user for valid credentials", async () => {
    const u = await seedCredentialedUser({ role: "admin" });
    const result = await login(db, SECRET, u.email, u.password);
    expect(result.user).toMatchObject({ id: u.id, email: u.email, role: "admin" });
    expect(result.expiresInSeconds).toBeGreaterThan(0);
    expect(await verifyAccessToken(SECRET, result.accessToken)).toEqual({ userId: u.id, role: "admin" });
    expect(result.refreshToken.length).toBeGreaterThan(20);
  });

  it("refuses a wrong password and an unknown email with ONE uniform message", async () => {
    // Distinct messages would let a caller enumerate which emails have accounts.
    const u = await seedCredentialedUser();
    const wrongPw = await login(db, SECRET, u.email, "nope").catch((e: AuthError) => e);
    const unknown = await login(db, SECRET, "nobody@example.com", "nope").catch((e: AuthError) => e);
    expect(wrongPw).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect((wrongPw as AuthError).status).toBe(401);
    expect((wrongPw as AuthError).message).toBe((unknown as AuthError).message);
  });

  it("refuses a suspended account with the recorded human-readable reason (FR-2.7)", async () => {
    const u = await seedCredentialedUser();
    await suspendUser(db, u.id, "billing dispute under review");
    const err = await login(db, SECRET, u.email, u.password).catch((e: AuthError) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).message).toMatch(/suspended/);
    expect((err as AuthError).message).toMatch(/billing dispute under review/);
  });
});

describe("refresh rotation (FR-2.2)", () => {
  it("issues a new pair and revokes the used token — reuse is refused", async () => {
    const u = await seedCredentialedUser();
    const first = await login(db, SECRET, u.email, u.password);
    const second = await refresh(db, SECRET, first.refreshToken);
    expect(second.user.id).toBe(u.id);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // the rotated-away token is dead
    await expect(refresh(db, SECRET, first.refreshToken)).rejects.toThrow(/invalid, expired, or already used/);
    // the new one still works
    await expect(refresh(db, SECRET, second.refreshToken)).resolves.toBeDefined();
  });

  it("refuses an expired refresh token", async () => {
    const u = await seedCredentialedUser();
    const token = await issueRefreshToken(db, u.id);
    await db
      .update(schema.refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.refreshTokens.userId, u.id));
    expect(await consumeRefreshToken(db, token)).toBeNull();
  });

  it("refuses garbage", async () => {
    await expect(refresh(db, SECRET, "no-such-token")).rejects.toThrow(AuthError);
  });

  it("cuts the refresh path for a suspended account too (FR-2.7)", async () => {
    const u = await seedCredentialedUser();
    const session = await login(db, SECRET, u.email, u.password);
    await suspendUser(db, u.id, "offboarding requested");
    const err = await refresh(db, SECRET, session.refreshToken).catch((e: AuthError) => e);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).message).toMatch(/suspended/);
  });
});

describe("suspend / reactivate (FR-2.7)", () => {
  it("is reversible: reactivation clears the state and login works again", async () => {
    const u = await seedCredentialedUser();
    await suspendUser(db, u.id, "temporary hold");
    await expect(login(db, SECRET, u.email, u.password)).rejects.toThrow(/suspended/);

    await reactivateUser(db, u.id);
    const row = await db.query.users.findFirst({ where: eq(schema.users.id, u.id) });
    expect(row?.suspendedAt).toBeNull();
    expect(row?.suspendedReason).toBeNull();
    await expect(login(db, SECRET, u.email, u.password)).resolves.toBeDefined();
  });
});
