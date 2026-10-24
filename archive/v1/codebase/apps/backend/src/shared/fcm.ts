import { importPKCS8, SignJWT } from "jose";
import type { Env } from "./env";

// FCM HTTP v1 from the Worker (design §9): the service-account JSON lives in the
// FCM_SERVICE_ACCOUNT secret; the OAuth assertion is minted with WebCrypto (RS256 via
// jose) and exchanged for a bearer token. Push failures are NEVER allowed to fail the
// caller — a notification is best-effort by design.

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** FCM requires string values; keys like draftId/runId let the app deep-link. */
  data?: Record<string, string>;
}

/** OAuth JWT assertion for the firebase.messaging scope — exported for tests. */
export async function buildFcmAssertion(sa: ServiceAccount): Promise<string> {
  const key = await importPKCS8(sa.private_key, "RS256");
  return new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

// Bearer-token cache. Isolate scope is fine HERE, unlike for flags (§10.1): a cached
// credential can only go stale, never make a kill switch advisory.
let cached: { token: string; expiresAt: number } | null = null;

export function resetFcmTokenCache(): void {
  cached = null;
}

type Fetcher = typeof fetch;

async function mintAccessToken(sa: ServiceAccount, fetchImpl: Fetcher): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await buildFcmAssertion(sa),
    }),
  });
  if (!res.ok) throw new Error(`FCM OAuth token exchange failed: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/** Send one push. Returns false (and warns) on ANY failure — callers never throw on push problems. */
export async function sendFcmPush(
  env: Env,
  deviceToken: string,
  msg: PushMessage,
  fetchImpl: Fetcher = fetch,
): Promise<boolean> {
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    const accessToken = await mintAccessToken(sa, fetchImpl);
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: msg.title, body: msg.body },
          ...(msg.data ? { data: msg.data } : {}),
        },
      }),
    });
    if (!res.ok) {
      console.warn(`FCM push failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("FCM push failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
