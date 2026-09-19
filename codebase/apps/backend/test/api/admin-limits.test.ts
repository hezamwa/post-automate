import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { seedUser } from "../db/harness";
import { techProfile } from "../fixtures";
import { seedCreator } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// PATCH /admin/users/:id/limits { autoPublish } (spec §5.2, brief §6): admin-writable only,
// audited in app_config_audit, refused for any profile with medical guardrails.
beforeEach(resetShared);

const medical = () =>
  techProfile({
    domain: { field: "medical", subNiches: ["emergency medicine"] },
    compliance: { noDiagnosis: true, noDosage: true, noCaseReferences: true, disclaimerText: "General information only." },
  });

describe("PATCH /admin/users/:id/limits — autoPublish", () => {
  it("enables the flag for a tech creator and writes the audit trail (who, old, new)", async () => {
    const { env } = apiEnv();
    const admin = await seedUser(shared.db, { role: "admin" });
    const creator = await seedCreator();
    const res = await call(env, `/admin/users/${creator}/limits`, { method: "PATCH", token: await tokenFor(admin, "admin"), body: { autoPublish: true } });
    expect(res.status).toBe(200);
    expect(res.json.limits).toMatchObject({ autoPublish: true });
    expect((await shared.db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, creator) }))?.autoPublish).toBe(true);
    const audit = await shared.db.select().from(schema.appConfigAudit);
    expect(audit).toMatchObject([{ key: `user_limits.auto_publish:${creator}`, oldValue: false, newValue: true, changedBy: admin, source: "admin" }]);
    // an unchanged value writes no trail; disabling writes one
    await call(env, `/admin/users/${creator}/limits`, { method: "PATCH", token: await tokenFor(admin, "admin"), body: { autoPublish: true } });
    await call(env, `/admin/users/${creator}/limits`, { method: "PATCH", token: await tokenFor(admin, "admin"), body: { autoPublish: false } });
    expect((await shared.db.select().from(schema.appConfigAudit)).map((a) => a.newValue)).toEqual([true, false]);
  });

  it("refuses a medical profile with 409, regardless of who asks (FR-7.2)", async () => {
    const { env } = apiEnv();
    const admin = await seedUser(shared.db, { role: "admin" });
    const creator = await seedCreator(medical());
    const res = await call(env, `/admin/users/${creator}/limits`, { method: "PATCH", token: await tokenFor(admin, "admin"), body: { autoPublish: true } });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/medical guardrails/);
    expect((await shared.db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, creator) }))?.autoPublish).toBe(false);
    expect(await shared.db.select().from(schema.appConfigAudit)).toEqual([]);
  });

  it("is not settable by the creator themselves (admin role required)", async () => {
    const { env } = apiEnv();
    const creator = await seedCreator();
    expect((await call(env, `/admin/users/${creator}/limits`, { method: "PATCH", token: await tokenFor(creator), body: { autoPublish: true } })).status).toBe(403);
  });

  it("GET shows the flag alongside the caps", async () => {
    const { env } = apiEnv();
    const admin = await seedUser(shared.db, { role: "admin" });
    const creator = await seedCreator();
    const res = await call(env, `/admin/users/${creator}/limits`, { token: await tokenFor(admin, "admin") });
    expect(res.json.limits).toMatchObject({ monthlyCapUsd: 10, autoPublish: false });
  });
});
