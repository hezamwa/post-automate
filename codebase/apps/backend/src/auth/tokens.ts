import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/client";

// Access + refresh token machinery (FR-2.2, design §2): short-lived JWT signed with
// JWT_SIGNING_KEY via jose; long-lived opaque refresh token stored SHA-256-hashed and
// rotated on every use. TTLs are conventional defaults — the design says only
// "short-lived" / "long-lived".

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

export interface AccessClaims {
  userId: string;
  role: "user" | "admin";
}

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(signingKey(secret));
}

/** Returns the claims, or null for anything invalid — missing, tampered, expired, wrong key. */
export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(secret));
    if (!payload.sub || (payload.role !== "user" && payload.role !== "admin")) return null;
    return { userId: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Issue a fresh refresh token for the user; only its hash is stored (design §2). */
export async function issueRefreshToken(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600_000);
  await db.insert(schema.refreshTokens).values({ userId, tokenHash: await sha256Hex(token), expiresAt });
  return token;
}

/**
 * Rotation: validate, revoke, and return the owning user — the caller issues a new pair.
 * A revoked or expired token returns null; reuse of a rotated token is therefore refused.
 */
export async function consumeRefreshToken(db: Db, token: string): Promise<{ userId: string } | null> {
  const row = await db.query.refreshTokens.findFirst({
    where: eq(schema.refreshTokens.tokenHash, await sha256Hex(token)),
  });
  if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.id, row.id));
  return { userId: row.userId };
}
