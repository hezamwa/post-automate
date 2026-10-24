import type { Env } from "../../shared/env";
import { expectOk, type Fetcher, type OAuthProvider, type TokenSet } from "./types";

// X (design §17): OAuth 2.0 authorization code + PKCE, confidential client (Basic auth).
// Access tokens last 2 hours; offline.access gives a rotating refresh token.

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const API = "https://api.x.com/2";
export const X_SCOPES = "tweet.read tweet.write users.read offline.access";

function basicAuth(env: Env): string {
  return `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`;
}

async function tokenCall(env: Env, form: Record<string, string>, f: Fetcher): Promise<TokenSet> {
  const res = await expectOk(
    "x",
    await f(`${API}/oauth2/token`, {
      method: "POST",
      headers: { authorization: basicAuth(env), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
  );
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in, scope: body.scope ?? X_SCOPES };
}

export const xProvider: OAuthProvider = {
  name: "x",
  usesPkce: true,
  missingConfig: (env) => (env.X_CLIENT_ID && env.X_CLIENT_SECRET ? null : "X is not configured yet — X_CLIENT_ID / X_CLIENT_SECRET are unset (runbook §6)."),

  authorizeUrl(env, { state, redirectUri, codeChallenge }) {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: env.X_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: X_SCOPES,
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE}?${q}`;
  },

  exchangeCode: (env, { code, redirectUri, codeVerifier }, f = fetch) =>
    tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier!, client_id: env.X_CLIENT_ID! }, f),

  refresh: (env, refreshToken, f = fetch) =>
    tokenCall(env, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.X_CLIENT_ID! }, f),

  async account(accessToken, f = fetch) {
    const res = await expectOk("x", await f(`${API}/users/me`, { headers: { authorization: `Bearer ${accessToken}` } }));
    const { data } = (await res.json()) as { data: { id: string; username: string } };
    return { id: data.id, handle: `@${data.username}` };
  },

  async revoke(env, token, f = fetch) {
    await f(`${API}/oauth2/revoke`, {
      method: "POST",
      headers: { authorization: basicAuth(env), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: env.X_CLIENT_ID! }),
    });
  },
};
