import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { createDb } from "../../db/client";
import { addEditDiff, getUserById, setDraftBlogType, updateDraftMarkdown } from "../../db/commands";
import { getDraftByRun } from "../../db/queries";
import { patchDraftMarkdown } from "../../modules/publishing";
import type { RunContext } from "../context";
import { defineGate } from "./gate";

// The approval gate (spec §5, AR-10.5). Always `ask`, for every user — it has no setting
// and is the one gate resolveGate does not handle. v1 semantics until the no-expiry
// phase: 7-day wait, timeout → expired.

export const approvalSchema = z.object({
  action: z.enum(["approve", "reject", "revise", "change_angle", "expired"]),
  publishMode: z.enum(["now", "next_slot"]).optional(), // FR-7.5
  editedMarkdown: z.string().optional(), // FR-6.9
  instructions: z.string().optional(), // FR-7.9 (revise)
  angleIndex: z.number().int().min(0).optional(), // change_angle
  rejectionCategory: z.enum(["quality", "changed_mind", "other"]).optional(), // FR-7.8
  blogType: z.enum(["public", "em"]).optional(), // Afnan's site: chosen per draft at approval (design §8)
});
export type ApprovalEventPayload = z.infer<typeof approvalSchema>;

export const DRAFT_EVENT_TYPE = "approval";
export const DRAFT_WAIT_TIMEOUT = "7 days";

/** Park until the reviewer decides. A wait that ends without an answer reads as `expired`. */
export async function waitForDraftDecision(step: WorkflowStep, attempt: number): Promise<ApprovalEventPayload> {
  let payload: unknown;
  try {
    const event = await step.waitForEvent<ApprovalEventPayload>(`approval-${attempt}`, {
      type: DRAFT_EVENT_TYPE,
      timeout: DRAFT_WAIT_TIMEOUT,
    });
    payload = event.payload;
  } catch {
    return { action: "expired" };
  }
  return approvalSchema.parse(payload);
}

export const draftGate = defineGate<ApprovalEventPayload>({
  name: "draft",
  options: async () => ({
    options: [
      { id: "approve", title: "Approve", summary: "Publish now or at the next slot", why: "" },
      { id: "revise", title: "Revise", summary: "Regenerate with your instructions (max 3)", why: "" },
      { id: "change_angle", title: "Change angle", summary: "Rewrite from another stored angle", why: "" },
      { id: "reject", title: "Reject", summary: "Discard with a reason", why: "" },
    ],
    recommended: "approve",
  }),
  choice: approvalSchema,
  recommended: async () => {
    throw new Error("the draft gate is always ask — it has no auto setting (spec §4.1)");
  },
  /** Approve-with-edits (FR-6.9) and the per-draft blogType land on the draft and its Sanity doc. */
  apply: async (ctx: RunContext, choice) => {
    if (choice.action !== "approve") return;
    const db = createDb(ctx.env);
    const draft = await getDraftByRun(db, ctx.runId);
    if (!draft) throw new Error(`run ${ctx.runId} has no draft to approve`);
    if (choice.blogType) await setDraftBlogType(db, draft.id, choice.blogType);
    const edited = choice.editedMarkdown;
    if (edited && draft.markdown != null && edited !== draft.markdown) {
      await addEditDiff(db, { draftId: draft.id, userId: ctx.userId, before: draft.markdown, after: edited });
      await updateDraftMarkdown(db, draft.id, edited);
      if (draft.sanityDocumentId) {
        await patchDraftMarkdown(ctx.env, await getUserById(db, ctx.userId), draft.sanityDocumentId, edited);
      }
    }
  },
});
