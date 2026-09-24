import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { api } from "../../src/api";
import { schema } from "../../src/db/client";
import { open } from "../../src/modules/social/crypto";
import type { Env } from "../../src/shared/env";
import { seedCreator } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// /social/* (FR-18.1, FR-18.7, NFR-11.8, design §17): connect through the platform's
// consent page with a single-use state, store the tokens sealed, list without tokens,
// disconnect with a best-effort revoke.
beforeEach(resetShared);
afterEach(() => vi.unstubAllGlobals());

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function socialEnv(extra: Partial<Env> = {}): Env {
  return Object.assign(apiEnv().env, {
    X_CLIENT_ID: "x-client",
    X_CLIENT_SECRET: "x-secret",
    LINKEDIN_CLIENT_ID: "li-client",
    LINKEDIN_CLIENT_SECRET: "li-secret",
    SOCIAL_TOKEN_KEY: KEY,
    ...extra,
  });
}

/** Fake platform: token exchange + account lookup, recording every request. */
function fakePlatform(tokens: Record<string, unknown>, account: Record<string, unknown>) {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : "" });
    if (url.includes("token") || url.includes("accessToken")) return Response.json(tokens);
    if (url.includes("revoke")) return new Response("", { status: 200 });
    return Response.json(account);
  });
  return calls;
}

async function callback(env: Env, provider: string, query: string) {
  const res = await api.request(`/social/${provider}/callback?${query}`, {}, env);
  return { status: res.status, html: await res.text() };
}

async function connect(env: Env, token: string, provider: string) {
  const res = await call(env, `/social/${provider}/connect`, { method: "POST", token });
  const url = new URL(res.json.authorizeUrl as string);
  return { res, url, state: url.searchParams.get("state")! };
}

describe("connect → callback (X, PKCE)", () => {
  it("stores the connection sealed, consumes the state, and lists it without tokens", async () => {
    const env = socialEnv();
    const userId = await seedCreator();
    const token = await tokenFor(userId);
    const { url, state } = await connect(env, token, "x");
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/social/x/callback");

    const calls = fakePlatform({ access_token: "AT", refresh_token: "RT", expires_in: 7200, scope: "tweet.write" }, { data: { id: "42", username: "waleed" } });
    const done = await callback(env, "x", `code=abc&state=${state}`);
    expect(done).toMatchObject({ status: 200, html: expect.stringContaining("@waleed is connected") });
    expect(calls[0]!.body).toContain("code_verifier="); // PKCE verifier sent with the exchange

    const row = await shared.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.userId, userId) });
    expect(row).toMatchObject({ provider: "x", accountId: "42", handle: "@waleed" });
    expect(row!.accessTokenEnc).not.toContain("AT");
    expect(await open(KEY, row!.refreshTokenEnc!)).toBe("RT");

    const listed = await call(env, "/social/accounts", { token });
    expect(listed.json.accounts).toMatchObject([{ provider: "x", handle: "@waleed", state: "connected" }]);
    expect(JSON.stringify(listed.json)).not.toMatch(/Enc|"AT"|"RT"/);

    // single-use: the same state again is refused
    expect((await callback(env, "x", `code=abc&state=${state}`)).html).toContain("expired or was already used");
  });

  it("503 with the reason while the platform's secrets are unset; the denial page on error", async () => {
    const env = socialEnv({ X_CLIENT_SECRET: undefined });
    const token = await tokenFor(await seedCreator());
    expect((await call(env, "/social/x/connect", { method: "POST", token })).json.error).toContain("X_CLIENT_SECRET");
    expect((await call(socialEnv({ SOCIAL_TOKEN_KEY: undefined }), "/social/x/connect", { method: "POST", token })).status).toBe(503);
    expect(await callback(env, "x", "error=access_denied&error_description=User+said+no")).toMatchObject({ status: 400, html: expect.stringContaining("User said no") });
  });
});

describe("LinkedIn", () => {
  it("connects without PKCE and reports expiry: connected → expiring → expired", async () => {
    const env = socialEnv();
    const userId = await seedCreator();
    const token = await tokenFor(userId);
    const { url, state } = await connect(env, token, "linkedin");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    fakePlatform({ access_token: "LAT", expires_in: 60 * 86400 }, { sub: "abc123", name: "Afnan" });
    expect((await callback(env, "linkedin", `code=c&state=${state}`)).status).toBe(200);

    const stateOf = async () => ((await call(env, "/social/accounts", { token })).json.accounts as Array<{ state: string }>)[0]!.state;
    expect(await stateOf()).toBe("connected");
    await shared.db.update(schema.socialAccounts).set({ expiresAt: new Date(Date.now() + 3 * 86400_000) }).where(eq(schema.socialAccounts.userId, userId));
    expect(await stateOf()).toBe("expiring");
    await shared.db.update(schema.socialAccounts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.socialAccounts.userId, userId));
    expect(await stateOf()).toBe("expired");
  });
});

describe("DELETE /social/:provider", () => {
  it("revokes at X best-effort and deletes the row; a second delete is 404", async () => {
    const env = socialEnv();
    const userId = await seedCreator();
    const token = await tokenFor(userId);
    const { state } = await connect(env, token, "x");
    const calls = fakePlatform({ access_token: "AT", refresh_token: "RT", expires_in: 7200 }, { data: { id: "1", username: "u" } });
    await callback(env, "x", `code=c&state=${state}`);

    expect((await call(env, "/social/x", { method: "DELETE", token })).status).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/oauth2/revoke") && c.body.includes("token=RT"))).toBe(true);
    expect(await shared.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.userId, userId) })).toBeUndefined();
    expect((await call(env, "/social/x", { method: "DELETE", token })).status).toBe(404);
  });
});
