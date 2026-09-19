import { z } from "zod";
import { createDb } from "../../db/client";
import { expireDraft, getUserById, rejectDraft, setRunState } from "../../db/commands";
import { deleteDraft } from "../../modules/publishing";
import { notifyUser } from "../../shared/notify";
import { defineStep, RETRY } from "./step";

// Spec §3 step 18: closes the run. One step, one outcome per invocation — the pipeline
// names each use (record-skip, record-failure, …). Published runs are closed by `publish`.

export const recordInputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("skipped"), reason: z.string(), kind: z.enum(["pending_drafts", "runs_paused", "no_topic"]) }),
  z.object({ outcome: z.literal("failed"), message: z.string() }),
  z.object({
    outcome: z.literal("rejected"),
    draftId: z.string().uuid(),
    sanityDocId: z.string().optional(),
    category: z.enum(["quality", "changed_mind", "other"]),
  }),
  z.object({ outcome: z.literal("expired"), draftId: z.string().uuid() }),
]);

export const record = defineStep({
  name: "record",
  input: recordInputSchema,
  output: z.object({ state: z.enum(["skipped", "failed", "rejected", "expired"]) }),
  retries: RETRY.io,
  run: async (ctx, input) => {
    const db = createDb(ctx.env);
    switch (input.outcome) {
      case "skipped":
        await setRunState(db, ctx.runId, "skipped", input.reason);
        if (input.kind === "pending_drafts") {
          // FR-7.4: a reminder push instead of a new draft
          await notifyUser(ctx.env, db, ctx.userId, {
            title: "Drafts waiting for your review",
            body: "Two drafts are already pending — review them to resume scheduled runs (FR-7.4).",
          });
        }
        break;
      case "failed":
        await setRunState(db, ctx.runId, "failed", input.message);
        // design §9: "run failed" push, so a broken pipeline is noticed, not discovered
        await notifyUser(ctx.env, db, ctx.userId, { title: "Pipeline run failed", body: input.message.slice(0, 200), data: { runId: ctx.runId } });
        break;
      case "rejected": {
        const user = await getUserById(db, ctx.userId);
        if (input.sanityDocId) {
          await deleteDraft(ctx.env, { projectId: user.sanityProjectId!, dataset: user.sanityDataset }, input.sanityDocId); // FR-7.8
        }
        await rejectDraft(db, input.draftId, input.category);
        await setRunState(db, ctx.runId, "rejected", `rejected: ${input.category}`);
        break;
      }
      case "expired":
        await expireDraft(db, input.draftId); // Sanity draft stays for manual handling (design §5)
        await setRunState(db, ctx.runId, "expired", "7-day approval timeout");
        break;
    }
    return { state: input.outcome };
  },
});
