import type { Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { getConnection, updateTokens } from "./accounts";
import { open } from "./crypto";
import { PROVIDERS } from "./oauth";
import type { Fetcher, SocialProvider } from "./types";

// A usable access token for posting (design §17 step 3): refreshed when it expires within a
// minute — persisting a rotated refresh token — or null when the connection is missing or
// expired beyond refresh (the channel then records not_connected, FR-18.7).

const MARGIN_MS = 60_000;

export interface LiveConnection {
  accessToken: string;
  accountId: string;
  handle: string;
}

export async function liveConnection(env: Env, db: Db, userId: string, provider: SocialProvider, f: Fetcher = fetch): Promise<LiveConnection | null> {
  const row = await getConnection(db, userId, provider);
  if (!row) return null;
  if (row.expiresAt.getTime() - Date.now() > MARGIN_MS) {
    return { accessToken: await open(env.SOCIAL_TOKEN_KEY, row.accessTokenEnc), accountId: row.accountId, handle: row.handle };
  }
  if (!row.refreshTokenEnc || (row.refreshExpiresAt && row.refreshExpiresAt <= new Date())) return null;
  const tokens = await PROVIDERS[provider].refresh(env, await open(env.SOCIAL_TOKEN_KEY, row.refreshTokenEnc), f);
  // a platform that does not rotate keeps the old refresh token
  const refreshToken = tokens.refreshToken ?? (await open(env.SOCIAL_TOKEN_KEY, row.refreshTokenEnc));
  await updateTokens(env, db, row.id, { ...tokens, refreshToken });
  return { accessToken: tokens.accessToken, accountId: row.accountId, handle: row.handle };
}
