import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { open, seal } from "./crypto";
import type { Fetcher, OAuthProvider, SocialAccount, SocialProvider, TokenSet } from "./types";

// Stored connections (DR-9.17, FR-18.7): sealed tokens in, a token-free view out.

type Row = typeof schema.socialAccounts.$inferSelect;
export type ConnectionState = "connected" | "expiring" | "expired";

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_WARNING_DAYS = 7;

const at = (seconds: number | undefined) => (seconds == null ? null : new Date(Date.now() + seconds * 1000));

export async function saveConnection(
  env: Env,
  db: Db,
  args: { userId: string; provider: SocialProvider; account: SocialAccount; tokens: TokenSet },
): Promise<void> {
  const values = {
    accountId: args.account.id,
    handle: args.account.handle,
    accessTokenEnc: await seal(env.SOCIAL_TOKEN_KEY, args.tokens.accessToken),
    refreshTokenEnc: args.tokens.refreshToken ? await seal(env.SOCIAL_TOKEN_KEY, args.tokens.refreshToken) : null,
    scopes: args.tokens.scope,
    expiresAt: at(args.tokens.expiresIn)!,
    refreshExpiresAt: at(args.tokens.refreshExpiresIn),
    expiryRemindedAt: null, // a (re)connect clears the reminder
    connectedAt: new Date(),
    updatedAt: new Date(),
  };
  await db
    .insert(schema.socialAccounts)
    .values({ userId: args.userId, provider: args.provider, ...values })
    .onConflictDoUpdate({ target: [schema.socialAccounts.userId, schema.socialAccounts.provider], set: values });
}

/** A refresh token keeps a connection alive past its access-token expiry. */
export function connectionState(row: Pick<Row, "expiresAt" | "refreshTokenEnc" | "refreshExpiresAt">, now = new Date()): ConnectionState {
  const until = row.refreshTokenEnc ? (row.refreshExpiresAt ?? null) : row.expiresAt;
  if (until == null) return "connected"; // refresh token with no stated expiry (X)
  if (until <= now) return "expired";
  return until.getTime() - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS ? "expiring" : "connected";
}

/** The app's view (FR-18.7) — never tokens. */
export async function listConnections(db: Db, userId: string) {
  const rows = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.userId, userId));
  return rows.map((r) => ({
    provider: r.provider,
    handle: r.handle,
    scopes: r.scopes,
    connectedAt: r.connectedAt,
    expiresAt: r.refreshTokenEnc ? r.refreshExpiresAt : r.expiresAt,
    state: connectionState(r),
  }));
}

export async function getConnection(db: Db, userId: string, provider: SocialProvider): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.userId, userId), eq(schema.socialAccounts.provider, provider)));
  return row ?? null;
}

/** Disconnect: best-effort revoke at the platform, then the row goes. */
export async function deleteConnection(env: Env, db: Db, userId: string, provider: OAuthProvider, f: Fetcher = fetch): Promise<boolean> {
  const row = await getConnection(db, userId, provider.name);
  if (!row) return false;
  if (provider.revoke) {
    try {
      await provider.revoke(env, await open(env.SOCIAL_TOKEN_KEY, row.refreshTokenEnc ?? row.accessTokenEnc), f);
    } catch (e) {
      console.warn(`social: ${provider.name} revoke failed — row deleted anyway:`, e instanceof Error ? e.message : e);
    }
  }
  await db.delete(schema.socialAccounts).where(eq(schema.socialAccounts.id, row.id));
  return true;
}
