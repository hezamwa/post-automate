import { Hono } from "hono";
import { profileSchema, type Profile } from "@post-automate/shared";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb } from "../db/client";
import { createProfileVersion, getActiveProfile } from "../modules/profiles";
import { hasMedicalGuardrails } from "../modules/profiles/medical";

// Design §7 /profile (FR-3.10–3.11): the profile page reads the active version and saves
// the WHOLE payload as a new version — profiles are append-only, never patched in place.

/** FR-6.6–6.8: an edit may never take a medical profile out from under its guardrails. */
function guardrailRegression(current: Profile, next: Profile): string | null {
  if (current.domain.field === "medical" && next.domain.field !== "medical") {
    return "A medical profile cannot be switched to another domain from the app — ask an administrator (FR-6.6).";
  }
  if (current.compliance && !next.compliance) {
    return "The compliance block cannot be removed from the app — ask an administrator (FR-3.9).";
  }
  return null;
}

export const profile = new Hono<AuthedEnv>()
  .use("*", requireAuth)

  .get("/", async (c) => {
    const active = await getActiveProfile(createDb(c.env), c.get("userId")).catch(() => null);
    if (!active) return c.json({ error: "You have no active profile yet — an administrator has to create one first." }, 404);
    return c.json({ version: active.version, profile: active.profile, medical: hasMedicalGuardrails(active.profile) });
  })

  .patch("/", async (c) => {
    const parsed = profileSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: `${issue?.path.join(".") || "profile"}: ${issue?.message ?? "invalid"}` }, 400);
    }
    const db = createDb(c.env);
    const userId = c.get("userId");
    const current = await getActiveProfile(db, userId).catch(() => null);
    if (!current) return c.json({ error: "You have no active profile to edit yet." }, 409);
    const refused = guardrailRegression(current.profile, parsed.data);
    if (refused) return c.json({ error: refused }, 409);
    const { version } = await createProfileVersion(db, userId, parsed.data);
    return c.json({ version, profile: parsed.data, medical: hasMedicalGuardrails(parsed.data) });
  });
