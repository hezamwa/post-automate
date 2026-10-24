import { eq } from "drizzle-orm";
import { GateError } from "../ai/gates";
import { schema, type Db } from "../db/client";
import { getUserById, rejectDraft, setRunState } from "../db/commands";
import { latestDerivativeRevision } from "../modules/generation";
import { getProfileVersion } from "../modules/profiles";
import { deleteDraft } from "../modules/publishing";
import type { Env } from "../shared/env";
import { createRunContext, pinProfile, type RunContext } from "./context";
import { derivativesGate } from "./gates/derivatives";
import { draftGate, type ApprovalEventPayload } from "./gates/draft";
import { profileOf } from "./context";
import { recordGateChoice } from "../db/commands";
import { deriveAll } from "./loops/derivatives";
import { publish } from "./steps/publish";
import { inlineStep } from "./steps/step";

// Direct handling (spec §5.1): the decision endpoint's fallback when the Workflow instance
// is gone. Runs the same step definitions the workflow would — approve → derive-x →
// derive-linkedin → translate → publish — inline, against the run's PINNED profile version.

type DraftRow = typeof schema.drafts.$inferSelect;

export { GateError };

type RunRow = typeof schema.pipelineRuns.$inferSelect;

/** A context for work on a run's behalf outside the engine, pinned to the run's profile version. */
export async function runContextFor(env: Env, db: Db, run: RunRow): Promise<RunContext> {
  const ctx = createRunContext(env, { runId: run.id, userId: run.userId, mood: run.mood, ...(run.userTopic ? { userTopic: run.userTopic as RunContext["userTopic"] } : {}) });
  pinProfile(ctx, await getProfileVersion(db, run.userId, run.profileVersion));
  return ctx;
}

async function contextFor(env: Env, db: Db, draft: DraftRow): Promise<RunContext> {
  const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });
  if (!run) throw new Error(`draft ${draft.id} has no run`);
  const ctx = await runContextFor(env, db, run);
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
  // the derivatives gate, from the approve payload (spec §4.1): ask → the ticked set, auto → the profile
  const auto = profileOf(ctx).gates.derivatives === "auto";
  const selection = auto || !args.decision.channels ? await derivativesGate.recommended(ctx) : { selected: args.decision.channels };
  await derivativesGate.apply(ctx, selection);
  await recordGateChoice(db, { runId: ctx.runId, userId: ctx.userId, gate: "derivatives", optionsShown: await derivativesGate.options(ctx), choice: selection, source: auto ? "auto" : "user" });
  const edited = args.decision.editedMarkdown != null && args.decision.editedMarkdown !== args.draft.markdown;
  const headline = (args.draft.angle as { headline?: string } | null)?.headline;
  await deriveAll(inlineStep(), ctx, { draftId: args.draft.id, revisionNo: ctx.revision, source: { title: headline }, force: edited });
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
