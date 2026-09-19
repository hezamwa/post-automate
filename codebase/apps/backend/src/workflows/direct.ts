import { eq } from "drizzle-orm";
import { GateError } from "../ai/gates";
import { schema, type Db } from "../db/client";
import { getUserById, rejectDraft, setRunState } from "../db/commands";
import { latestDerivativeRevision } from "../modules/generation";
import { getProfileVersion } from "../modules/profiles";
import { deleteDraft } from "../modules/publishing";
import type { Env } from "../shared/env";
import { createRunContext, pinProfile, type RunContext } from "./context";
import { draftGate, type ApprovalEventPayload } from "./gates/draft";
import { deriveAll } from "./loops/derivatives";
import { publish } from "./steps/publish";
import { inlineStep } from "./steps/step";

// Direct handling (spec §5.1): the decision endpoint's fallback when the Workflow instance
// is gone. Runs the same step definitions the workflow would — approve → derive-x →
// derive-linkedin → translate → publish — inline, against the run's PINNED profile version.

type DraftRow = typeof schema.drafts.$inferSelect;

export { GateError };

async function contextFor(env: Env, db: Db, draft: DraftRow): Promise<RunContext> {
  const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });
  if (!run) throw new Error(`draft ${draft.id} has no run`);
  const ctx = createRunContext(env, { runId: run.id, userId: run.userId });
  pinProfile(ctx, await getProfileVersion(db, run.userId, run.profileVersion));
  ctx.revision = await latestDerivativeRevision(db, draft.id);
  return ctx;
}

/** approve → derivatives → publish / schedule, without a live instance. Throws GateError when publishing is paused. */
export async function approveDirect(
  env: Env,
  db: Db,
  args: { draft: DraftRow; decision: ApprovalEventPayload },
): Promise<"published" | "scheduled"> {
  const ctx = await contextFor(env, db, args.draft);
  await draftGate.apply(ctx, { ...args.decision, action: "approve" });
  const headline = (args.draft.angle as { headline?: string } | null)?.headline;
  await deriveAll(inlineStep(), ctx, { draftId: args.draft.id, revisionNo: ctx.revision, source: { title: headline } });
  const { status } = await publish.run(ctx, { draftId: args.draft.id, publishMode: args.decision.publishMode ?? "now" });
  return status;
}

/** reject without a live instance (FR-7.8): Sanity draft deleted, category stored, markdown purged. */
export async function rejectDirect(env: Env, db: Db, args: { draft: DraftRow; category: "quality" | "changed_mind" | "other" }): Promise<void> {
  const user = await getUserById(db, args.draft.userId);
  if (args.draft.sanityDocumentId?.startsWith("drafts.")) {
    await deleteDraft(env, { projectId: user.sanityProjectId!, dataset: user.sanityDataset }, args.draft.sanityDocumentId);
  }
  await rejectDraft(db, args.draft.id, args.category);
  await setRunState(db, args.draft.runId, "rejected", `rejected: ${args.category}`);
}
