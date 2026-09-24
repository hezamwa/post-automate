import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { techProfile } from "../fixtures";
import { recordGateChoice } from "../../src/db/commands";
import { seedCreator, seedDraftRow, startRun } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// /profile and /me/data (FR-3.11, FR-3.14–3.15, design §7): the profile page reads the
// active version and saves the whole payload as a NEW version; medical guardrails cannot
// be edited away; "My data" is read-only and never carries secrets.
beforeEach(resetShared);

const medical = () =>
  techProfile({
    domain: { field: "medical", subNiches: ["cardiology"] },
    compliance: { noDiagnosis: true, noDosage: true, noCaseReferences: true, disclaimerText: "Not advice." },
  });

describe("GET/PATCH /profile", () => {
  it("reads the active version with its defaults, and saves an edit as the next version", async () => {
    const { env } = apiEnv();
    const token = await tokenFor(await seedCreator());
    const read = await call(env, "/profile", { token });
    expect(read.json).toMatchObject({ version: 1, medical: false, profile: { socialPosting: "confirm", autoRun: false } });

    const edited = { ...(read.json.profile as object), autoRun: true, socialPosting: "auto" };
    const saved = await call(env, "/profile", { method: "PATCH", token, body: edited });
    expect(saved.json).toMatchObject({ version: 2, profile: { autoRun: true, socialPosting: "auto" } });
    expect((await call(env, "/profile", { token })).json).toMatchObject({ version: 2, profile: { socialPosting: "auto" } });
  });

  it("rejects an invalid payload with the field that failed (400)", async () => {
    const { env } = apiEnv();
    const token = await tokenFor(await seedCreator());
    const res = await call(env, "/profile", { method: "PATCH", token, body: { ...techProfile(), socialPosting: "sometimes" } });
    expect(res).toMatchObject({ status: 400, json: { error: expect.stringContaining("socialPosting") } });
  });

  it("refuses to take a medical profile out of its guardrails (409)", async () => {
    const { env } = apiEnv();
    const token = await tokenFor(await seedCreator(medical()));
    expect((await call(env, "/profile", { token })).json.medical).toBe(true);
    const toTech = await call(env, "/profile", { method: "PATCH", token, body: techProfile() });
    expect(toTech).toMatchObject({ status: 409, json: { error: expect.stringContaining("medical profile") } });
    const kept = await call(env, "/profile", { method: "PATCH", token, body: { ...medical(), autoRun: true } });
    expect(kept.status).toBe(200);
  });
});

describe("GET /me/data", () => {
  it("lists what is stored, owner-scoped, without the password hash", async () => {
    const { env } = apiEnv();
    const params = await startRun();
    await seedDraftRow(params, {});
    await recordGateChoice(shared.db, { runId: params.runId, userId: params.userId, gate: "topic", optionsShown: {}, choice: { freeText: "my own" }, source: "user" });
    const other = await startRun();
    await seedDraftRow(other, {});

    const res = await call(env, "/me/data", { token: await tokenFor(params.userId) });
    expect(res.status).toBe(200);
    expect(res.json.account).not.toHaveProperty("passwordHash");
    expect(res.json.profileVersions).toMatchObject([{ version: 1, status: "active" }]);
    expect(res.json.gateChoices).toMatchObject([{ gate: "topic", freeText: "my own", source: "user" }]);
    expect(res.json.draftsByStatus).toEqual([{ status: "pending_approval", n: 1 }]);
    expect(res.json.spend).toMatchObject({ monthToDateUsd: 0, autoPublish: false });
    expect(JSON.stringify(res.json)).not.toMatch(/password|token/i);
  });
});
