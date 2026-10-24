import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { notifyUser } from "../../shared/notify";
import { defineStep, RETRY } from "./step";

// Spec §3 step 13 (FR-7.1): "draft ready" push, then the run parks at the draft gate.
// Best-effort — a failed push never fails the run.
export const notify = defineStep({
  name: "notify",
  input: z.object({ draftId: z.string().uuid(), title: z.string(), revised: z.boolean() }),
  output: z.object({ pushed: z.boolean() }),
  retries: RETRY.io,
  run: async (ctx, { draftId, title, revised }) => {
    const db = createDb(ctx.env);
    console.log("pipeline: draft ready for review", { runId: ctx.runId, draftId, revised });
    const pushed = await notifyUser(ctx.env, db, ctx.userId, {
      title: revised ? "Revised draft ready for review" : "Draft ready for review",
      body: title,
      data: { draftId, runId: ctx.runId },
    });
    await setRunState(db, ctx.runId, "pending_approval");
    return { pushed };
  },
});
