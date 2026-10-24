import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { schema } from "../../../src/db/client";
import { notify } from "../../../src/workflows/steps/notify";
import { runStep } from "../../../src/workflows/steps/step";
import { runRow, seedDraftRow, stepContext } from "../harness";

// notify (spec §3 step 13, FR-7.1): best-effort push, then the run parks at pending_approval.
beforeEach(resetShared);

describe("notify step", () => {
  it("pushes draft-ready with deep-link data and parks the run", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, notify, { draftId, title: "Hello", revised: false })).toEqual({ pushed: true });
    expect(shared.pushes).toEqual([{ token: "device-token", title: "Draft ready for review", body: "Hello", data: { draftId, runId: ctx.runId } }]);
    expect((await runRow(ctx.runId))?.state).toBe("pending_approval");
  });

  it("titles a revision differently", async () => {
    const ctx = await stepContext();
    const draftId = await seedDraftRow(ctx);
    await runStep(shared.step as never, ctx, notify, { draftId, title: "Hello", revised: true }, "rev1");
    expect(shared.pushes[0]?.title).toBe("Revised draft ready for review");
  });

  it("never fails the run for a user without a device token", async () => {
    const ctx = await stepContext();
    await shared.db.update(schema.users).set({ fcmToken: null }).where(eq(schema.users.id, ctx.userId));
    const draftId = await seedDraftRow(ctx);
    expect(await runStep(shared.step as never, ctx, notify, { draftId, title: "Hello", revised: false })).toEqual({ pushed: false });
    expect((await runRow(ctx.runId))?.state).toBe("pending_approval");
  });
});
