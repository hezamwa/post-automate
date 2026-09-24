import type { Env } from "../../shared/env";
import { expectOk, type Fetcher, type OAuthProvider, type TokenSet } from "./types";

// LinkedIn (design §17): OAuth 2.0 authorization code; OpenID Connect gives the member id.
// A standard app's access token lasts ~60 days with no refresh token — the user reconnects
// (FR-18.7). A refresh token is used only if LinkedIn issues one.

const AUTH = "https://www.linkedin.com/oauth/v2";
export const LINKEDIN_SCOPES = "openid profile w_member_social";

async function tokenCall(env: Env, form: Record<string, string>, f: Fetcher): Promise<TokenSet> {
  const res = await expectOk(
    "linkedin",
    await f(`${AUTH}/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: env.LINKEDIN_CLIENT_ID!, client_secret: env.LINKEDIN_CLIENT_SECRET! }),
    }),
  );
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    refreshExpiresIn: body.refresh_token_expires_in,
    scope: body.scope ?? LINKEDIN_SCOPES,
  };
}

export const linkedinProvider: OAuthProvider = {
  name: "linkedin",
  usesPkce: false,
  missingConfig: (env) =>
    env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET ? null : "LinkedIn is not configured yet — LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are unset (runbook §6).",

  authorizeUrl(env, { state, redirectUri }) {
    const q = new URLSearchParams({ response_type: "code", client_id: env.LINKEDIN_CLIENT_ID!, redirect_uri: redirectUri, state, scope: LINKEDIN_SCOPES });
    return `${AUTH}/authorization?${q}`;
  },

  exchangeCode: (env, { code, redirectUri }, f = fetch) => tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f),

  refresh: (env, refreshToken, f = fetch) => tokenCall(env, { grant_type: "refresh_token", refresh_token: refreshToken }, f),

  async account(accessToken, f = fetch) {
    const res = await expectOk("linkedin", await f("https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${accessToken}` } }));
    const body = (await res.json()) as { sub: string; name?: string };
    return { id: body.sub, handle: body.name ?? "LinkedIn member" };
  },
};
