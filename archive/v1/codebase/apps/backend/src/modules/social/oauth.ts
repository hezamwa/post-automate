import { and, eq, gt } from "drizzle-orm";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { saveConnection } from "./accounts";
import { linkedinProvider } from "./linkedin";
import type { Fetcher, OAuthProvider, SocialAccount, SocialProvider } from "./types";
import { xProvider } from "./x";

// Connecting (FR-18.1, design §17): a single-use 10-minute state row carries the user, the
// PKCE verifier and the exact redirect URI from connect to callback.

export const PROVIDERS: Record<SocialProvider, OAuthProvider> = { x: xProvider, linkedin: linkedinProvider };
const STATE_TTL_MS = 10 * 60 * 1000;

export function providerOf(name: string): OAuthProvider | null {
  return name === "x" || name === "linkedin" ? PROVIDERS[name] : null;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Create the state row and return the platform's consent URL for the app to open. */
export async function startConnect(env: Env, db: Db, args: { userId: string; provider: OAuthProvider; redirectUri: string }): Promise<string> {
  const state = randomToken();
  const codeVerifier = args.provider.usesPkce ? randomToken() : undefined;
  await db.insert(schema.oauthStates).values({
    state,
    userId: args.userId,
    provider: args.provider.name,
    codeVerifier: codeVerifier ?? null,
    redirectUri: args.redirectUri,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return args.provider.authorizeUrl(env, { state, redirectUri: args.redirectUri, codeChallenge: codeVerifier && (await s256(codeVerifier)) });
}

/** Consume the state, exchange the code, read the account, store the sealed tokens. */
export async function completeConnect(
  env: Env,
  db: Db,
  args: { provider: OAuthProvider; code: string; state: string },
  f: Fetcher = fetch,
): Promise<SocialAccount> {
  const [row] = await db
    .delete(schema.oauthStates)
    .where(and(eq(schema.oauthStates.state, args.state), eq(schema.oauthStates.provider, args.provider.name), gt(schema.oauthStates.expiresAt, new Date())))
    .returning();
  if (!row) throw new Error("This connection link has expired or was already used — start again from the app.");
  const tokens = await args.provider.exchangeCode(env, { code: args.code, redirectUri: row.redirectUri, codeVerifier: row.codeVerifier ?? undefined }, f);
  const account = await args.provider.account(tokens.accessToken, f);
  await saveConnection(env, db, { userId: row.userId, provider: args.provider.name, account, tokens });
  return account;
}
