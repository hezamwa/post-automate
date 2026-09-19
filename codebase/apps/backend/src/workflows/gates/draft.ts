import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { createDb } from "../../db/client";
import { addEditDiff, getUserById, setDraftBlogType, updateDraftMarkdown } from "../../db/commands";
import { getDraftByRun } from "../../db/queries";
import { approvedKinds } from "../../modules/generation/channels";
import { patchDraftMarkdown } from "../../modules/publishing";
import { profileOf, type RunContext } from "../context";
import { defineGate } from "./gate";
import { schema } from "../../db/client";
import { eq } from "drizzle-orm";

// The approval gate (spec §5, AR-10.5). Always `ask`, for every user — it has no setting
// and is the one gate resolveGate does not handle. It never expires the DRAFT: the wait
// is the longest Workflows allows, and when the instance finally times out the draft is
// flagged stale and stays first in the queue (spec §5.1).

export const approvalSchema = z.object({
  /** `timeout` is internal: the wait ended without an answer (spec §5.1) — never sent by the app. */
  action: z.enum(["approve", "reject", "revise", "change_angle", "timeout"]),
  publishMode: z.enum(["now", "next_slot"]).optional(), // FR-7.5
  editedMarkdown: z.string().optional(), // FR-6.9
  /** The derivatives gate (spec §4.1): ticked kinds; absent = the profile decides. */
  channels: z.array(z.enum(["x", "linkedin", "translation"])).optional(),
  instructions: z.string().optional(), // FR-7.9 (revise)
  angleIndex: z.number().int().min(0).optional(), // change_angle
  rejectionCategory: z.enum(["quality", "changed_mind", "other"]).optional(), // FR-7.8
  blogType: z.enum(["public", "em"]).optional(), // Afnan's site: chosen per draft at approval (design §8)
});
export type ApprovalEventPayload = z.infer<typeof approvalSchema>;

export const DRAFT_EVENT_TYPE = "approval";
/** The maximum a Workflows waitForEvent may wait (limits doc: 365 days). */
export const DRAFT_WAIT_TIMEOUT = "365 days";

/** Park until the reviewer decides. A wait that ends without an answer reads as `timeout`. */
export async function waitForDraftDecision(step: WorkflowStep, attempt: number): Promise<ApprovalEventPayload> {
  let payload: unknown;
  try {
    const event = await step.waitForEvent<ApprovalEventPayload>(`approval-${attempt}`, {
      type: DRAFT_EVENT_TYPE,
      timeout: DRAFT_WAIT_TIMEOUT,
    });
    payload = event.payload;
  } catch {
    return { action: "timeout" };
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
  /**
   * Approve: edits (FR-6.9) and blogType land on the draft and its Sanity doc; the ticked
   * derivatives — narrowed to what the profile supports — are stored as drafts.channels,
   * which the derive steps read (spec §4.1).
   */
  apply: async (ctx: RunContext, choice) => {
    if (choice.action !== "approve") return;
    const db = createDb(ctx.env);
    const draft = await getDraftByRun(db, ctx.runId);
    if (!draft) throw new Error(`run ${ctx.runId} has no draft to approve`);
    if (choice.blogType) await setDraftBlogType(db, draft.id, choice.blogType);
    await db.update(schema.drafts).set({ channels: approvedKinds(profileOf(ctx), choice.channels) }).where(eq(schema.drafts.id, draft.id));
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
