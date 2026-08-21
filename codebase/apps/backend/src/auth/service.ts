import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { verifyPassword } from "../shared/password";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  consumeRefreshToken,
  issueAccessToken,
  issueRefreshToken,
} from "./tokens";

// Login / refresh flows (FR-2.2, FR-2.7). One auth/ module (design §2): registration
// and password reset later mean adding routes here, not reworking callers.

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: { id: string; email: string; displayName: string; role: "user" | "admin" };
}

type UserRow = typeof schema.users.$inferSelect;

// FR-2.7: authentication is refused with a human-readable reason while suspended.
function assertNotSuspended(user: UserRow): void {
  if (user.suspendedAt) {
    throw new AuthError(
      403,
      `This account is suspended (${user.suspendedReason ?? "no reason recorded"}) — contact the administrator to reactivate it (FR-2.7).`,
    );
  }
}

async function issuePair(db: Db, jwtSecret: string, user: UserRow): Promise<AuthResult> {
  return {
    accessToken: await issueAccessToken(jwtSecret, { userId: user.id, role: user.role }),
    refreshToken: await issueRefreshToken(db, user.id),
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
  };
}

export async function login(db: Db, jwtSecret: string, email: string, password: string): Promise<AuthResult> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  // One uniform message for unknown email and wrong password — no account enumeration.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new AuthError(401, "Invalid email or password.");
  }
  assertNotSuspended(user);
  return issuePair(db, jwtSecret, user);
}

export async function refresh(db: Db, jwtSecret: string, refreshToken: string): Promise<AuthResult> {
  const consumed = await consumeRefreshToken(db, refreshToken);
  if (!consumed) {
    throw new AuthError(401, "Refresh token is invalid, expired, or already used — log in again.");
  }
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, consumed.userId) });
  if (!user) throw new AuthError(401, "Account no longer exists.");
  assertNotSuspended(user); // suspension also cuts the refresh path (FR-2.7)
  return issuePair(db, jwtSecret, user);
}
