import { z } from "zod";
import { createDb } from "../../db/client";
import { getUserById, scheduleDraft, setRunState } from "../../db/commands";
import { publishApprovedDraft } from "../../modules/publishing";
import { computeNextSlot } from "../../modules/publishing/schedule";
import { profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 17 / §6 (FR-7.5): every publish path goes through publishApprovedDraft —
// production only (FR-8.5). next_slot schedules; the hourly publisher publishes.
export const publish = defineStep({
  name: "publish",
  input: z.object({ draftId: z.string().uuid(), publishMode: z.enum(["now", "next_slot"]) }),
  output: z.object({ status: z.enum(["published", "scheduled"]) }),
  retries: RETRY.io,
  run: async (ctx, { draftId, publishMode }) => {
    const db = createDb(ctx.env);
    if (publishMode === "next_slot") {
      await scheduleDraft(db, draftId, computeNextSlot(profileOf(ctx)));
      await setRunState(db, ctx.runId, "publishing");
      return { status: "scheduled" as const };
    }
    await publishApprovedDraft(ctx.env, db, { user: await getUserById(db, ctx.userId), draftId });
    await setRunState(db, ctx.runId, "published");
    return { status: "published" as const };
  },
});
