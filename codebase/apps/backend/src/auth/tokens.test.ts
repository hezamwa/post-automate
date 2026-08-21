import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { issueAccessToken, verifyAccessToken } from "./tokens";

// Access-token round-trip on the Workers pool (FR-2.2): jose + WebCrypto exactly as in
// production. Refresh tokens touch the DB and are covered in test/db/auth.test.ts.

const SECRET = "test-signing-key-0123456789abcdef";
const CLAIMS = { userId: "3f1a0e51-0000-4000-8000-000000000001", role: "admin" as const };

describe("access tokens (FR-2.2)", () => {
  it("round-trips userId and role", async () => {
    const token = await issueAccessToken(SECRET, CLAIMS);
    expect(await verifyAccessToken(SECRET, token)).toEqual(CLAIMS);
  });

  it("rejects a token signed with a different key", async () => {
    const token = await issueAccessToken("some-other-key-with-enough-length", CLAIMS);
    expect(await verifyAccessToken(SECRET, token)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await issueAccessToken(SECRET, CLAIMS);
    const [h, p, s] = token.split(".");
    const flipped = p![5] === "A" ? "B" : "A";
    const tampered = `${h}.${p!.slice(0, 5)}${flipped}${p!.slice(6)}.${s}`;
    expect(await verifyAccessToken(SECRET, tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.userId)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyAccessToken(SECRET, expired)).toBeNull();
  });

  it("rejects garbage and a token missing its role claim", async () => {
    expect(await verifyAccessToken(SECRET, "not-a-jwt")).toBeNull();
    const roleless = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.userId)
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyAccessToken(SECRET, roleless)).toBeNull();
  });
});
