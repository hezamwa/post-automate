import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { AuthError, login, refresh } from "../auth/service";
import { createDb, schema } from "../db/client";

// FR-2.2: JWT login/refresh. Bodies are never logged (NFR-11.7) — no logging here at all.
export const auth = new Hono<AuthedEnv>()
  .post("/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: "Body must include { email, password }." }, 400);
    }
    try {
      return c.json(await login(createDb(c.env), c.env.JWT_SIGNING_KEY, body.email, body.password));
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  })
  .post("/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: string };
    if (!body.refreshToken) return c.json({ error: "Body must include { refreshToken }." }, 400);
    try {
      return c.json(await refresh(createDb(c.env), c.env.JWT_SIGNING_KEY, body.refreshToken));
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  })
  // design §9: the Flutter app refreshes users.fcm_token on launch. (No route in the
  // §7 table for this — flagged as a doc gap; the push flow is unreachable without it.)
  .post("/fcm-token", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!body.token || typeof body.token !== "string" || body.token.length < 10) {
      return c.json({ error: "Body must include { token } — the device's FCM registration token." }, 400);
    }
    await createDb(c.env)
      .update(schema.users)
      .set({ fcmToken: body.token })
      .where(eq(schema.users.id, c.get("userId")));
    return c.json({ ok: true });
  });
