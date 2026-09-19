import { z } from "zod";
import { createDb } from "../../db/client";
import { getUserById, markDraftStale, rejectDraft, setRunState } from "../../db/commands";
import { deleteDraft } from "../../modules/publishing";
import { notifyUser } from "../../shared/notify";
import { defineStep, RETRY } from "./step";

// Spec §3 step 18: closes the run — or, for `stale`, closes only the INSTANCE: the run
// stays pending_approval and the draft keeps everything (spec §5.1). One outcome per
// invocation; the pipeline names each use (record-skip, record-failure, …). Published
// runs are closed by `publish`.

export const recordInputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("skipped"), reason: z.string(), kind: z.enum(["pending_drafts", "runs_paused", "no_topic"]) }),
  z.object({ outcome: z.literal("failed"), message: z.string() }),
  z.object({
    outcome: z.literal("rejected"),
    draftId: z.string().uuid(),
    sanityDocId: z.string().optional(),
    category: z.enum(["quality", "changed_mind", "other"]),
  }),
  z.object({ outcome: z.literal("stale"), draftId: z.string().uuid() }),
  z.object({ outcome: z.literal("abandoned"), gate: z.string() }),
  z.object({ outcome: z.literal("held") }),
]);

export const record = defineStep({
  name: "record",
  input: recordInputSchema,
  output: z.object({ state: z.enum(["skipped", "failed", "rejected", "stale", "abandoned", "held"]) }),
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
            body: "A draft is already waiting — approve, edit or reject it to get a new one (FR-7.4).",
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
      case "held":
        // Publish gate "hold" (spec §4.3, §5): back to the drafts queue, nothing goes live;
        // the derivatives already produced stay with the draft.
        await setRunState(db, ctx.runId, "pending_approval");
        break;
      case "abandoned":
        // Spec §4.2: a pre-draft gate unanswered for 30 days. The small spend so far stays
        // attributed to the run (spend_ledger.run_id); never auto-proceed.
        await setRunState(db, ctx.runId, "abandoned", `abandoned at the ${input.gate} gate — no answer in 30 days (spec §4.2)`);
        break;
      case "stale":
        // Nothing is lost: markdown kept, Sanity draft kept, still first in the queue.
        // approve/reject work through direct handling; reminders keep going weekly.
        await markDraftStale(db, input.draftId);
        console.log("pipeline: instance timed out at the draft gate — draft flagged stale", { runId: ctx.runId, draftId: input.draftId });
        break;
    }
    return { state: input.outcome };
  },
});
