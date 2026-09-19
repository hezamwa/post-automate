import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { createRunContext } from "../../../src/workflows/context";
import { loadProfile } from "../../../src/workflows/steps/load-profile";
import { runStep } from "../../../src/workflows/steps/step";
import { seedRun, seedUser } from "../../db/harness";
import { techProfile } from "../../fixtures";
import { env } from "../preamble";
import { startRun } from "../harness";

// load-profile (spec §3 step 2): the active version, validated, pinned for the run.
beforeEach(resetShared);

describe("load-profile step", () => {
  it("pins the active profile version", async () => {
    const out = await runStep(shared.step as never, createRunContext(env, await startRun()), loadProfile, {});
    expect(out.version).toBe(1);
    expect(out.profile).toMatchObject({ identity: { displayName: "Test Creator" }, format: { targetWords: 1200 } });
    expect(out.profile).toEqual(techProfile());
  });

  it("fails when the user has no active profile", async () => {
    const userId = await seedUser(shared.db);
    const runId = await seedRun(shared.db, userId);
    await expect(runStep(shared.step as never, createRunContext(env, { runId, userId }), loadProfile, {})).rejects.toThrow(/No ACTIVE profile/);
  });
});
