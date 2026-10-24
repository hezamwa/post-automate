import { Hono } from "hono";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb } from "../db/client";
import { deleteConnection, listConnections } from "../modules/social/accounts";
import { completeConnect, providerOf, startConnect } from "../modules/social/oauth";
import type { Env } from "../shared/env";

// Design §7 /social/* (FR-18.1, FR-18.7, NFR-11.8): connect through the platform's own
// consent page — never a password — list connections without tokens, disconnect.

const redirectUriFor = (requestUrl: string, provider: string) => `${new URL(requestUrl).origin}/social/${provider}/callback`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The page the platform redirects the browser to — the user just returns to the app. */
function resultPage(title: string, detail: string, status: 200 | 400 = 200): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function refuseUnconfigured(env: Env, provider: NonNullable<ReturnType<typeof providerOf>>): string | null {
  return provider.missingConfig(env) ?? (env.SOCIAL_TOKEN_KEY ? null : "Social accounts are not configured yet — SOCIAL_TOKEN_KEY is unset (runbook §6).");
}

const authed = new Hono<AuthedEnv>()
  .use("*", requireAuth)
  .get("/accounts", async (c) => c.json({ accounts: await listConnections(createDb(c.env), c.get("userId")) }))
  .post("/:provider/connect", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown provider — x or linkedin" }, 404);
    const unconfigured = refuseUnconfigured(c.env, provider);
    if (unconfigured) return c.json({ error: unconfigured }, 503);
    const authorizeUrl = await startConnect(c.env, createDb(c.env), {
      userId: c.get("userId"),
      provider,
      redirectUri: redirectUriFor(c.req.url, provider.name),
    });
    return c.json({ authorizeUrl });
  })
  .delete("/:provider", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown provider — x or linkedin" }, 404);
    const removed = await deleteConnection(c.env, createDb(c.env), c.get("userId"), provider);
    if (!removed) return c.json({ error: "not connected" }, 404);
    return c.json({
      ok: true,
      note: provider.revoke ? undefined : "LinkedIn has no revoke for member tokens — remove the app under LinkedIn Settings → Data privacy → Permitted services.",
    });
  });

export const social = new Hono<{ Bindings: Env }>()
  // Unauthenticated by design: the single-use state row is what authenticates it.
  .get("/:provider/callback", async (c) => {
    const provider = providerOf(c.req.param("provider"));
    if (!provider) return resultPage("Unknown service", "This link is not for X or LinkedIn.", 400);
    const { code, state, error, error_description: why } = c.req.query();
    if (error || !code || !state) {
      return resultPage("Not connected", why ?? error ?? "The platform did not return an authorization code. You can try again from the app.", 400);
    }
    try {
      const account = await completeConnect(c.env, createDb(c.env), { provider, code, state });
      return resultPage("Connected", `${account.handle} is connected. You can close this page and return to the app.`);
    } catch (e) {
      return resultPage("Not connected", e instanceof Error ? e.message : "Something went wrong — try again from the app.", 400);
    }
  })
  .route("/", authed);
