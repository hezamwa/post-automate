import { beforeEach, describe, expect, it } from "vitest";
import { GateError } from "../../src/ai/gates";
import { schema } from "../../src/db/client";
import { publishApprovedDraft } from "../../src/modules/publishing";
import type { Env } from "../../src/shared/env";
import { createTestDb, seedDraft, seedRun, seedUser, type TestDb } from "./harness";

// FR-15.12b: publishing.paused refuses at the point of the Sanity write — the single
// choke point shared by the decision endpoint, the Workflow publish step, and the
// hourly publisher. The check must fire BEFORE any Sanity traffic: env is a bare stub
// here, so reaching the network (or even the token lookup) would throw something else.

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});

describe("publishApprovedDraft — publishing.paused (FR-15.12b)", () => {
  it("refuses with the switch named, before any Sanity write", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await seedDraft(db, userId, runId, "pending_approval");
    await db.insert(schema.appConfig).values({ key: "publishing.paused", value: true });

    const user = { id: userId, sanityProjectId: "test000", sanityDataset: "production" };
    await publishApprovedDraft({} as Env, db, { user, draftId: "irrelevant" }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(GateError);
        expect((e as GateError).gate).toBe("publishing_paused");
        expect((e as GateError).message).toMatch(/Publishing is paused by an administrator/);
      },
    );
  });

  it("proceeds past the gate when the switch is off (fails later, on the missing document)", async () => {
    const userId = await seedUser(db);
    const runId = await seedRun(db, userId);
    await seedDraft(db, userId, runId, "pending_approval");
    const user = { id: userId, sanityProjectId: "test000", sanityDataset: "production" };
    // Same stub env — the error now comes from AFTER the gate, proving the gate is
    // what refused above, not some earlier failure.
    await expect(publishApprovedDraft({} as Env, db, { user, draftId: crypto.randomUUID() })).rejects.toThrow(
      /has no Sanity document/,
    );
  });
});
