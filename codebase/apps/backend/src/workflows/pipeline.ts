import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../shared/env";
import { createRunContext, pinProfile, type PipelineParams } from "./context";
import { chooseAngle } from "./gates/angle";
import { applyGate } from "./gates/gate";
import { draftGate, waitForDraftDecision } from "./gates/draft";
import { deriveAll } from "./loops/derivatives";
import { reviewable, reviewLoop } from "./loops/revise";
import { angles } from "./steps/angles";
import { draft } from "./steps/draft";
import { entryGates } from "./steps/gates";
import { loadProfile } from "./steps/load-profile";
import { publish } from "./steps/publish";
import { record } from "./steps/record";
import { research } from "./steps/research";
import { saveDraft } from "./steps/save-draft";
import { score } from "./steps/score";
import { search } from "./steps/search";
import { runStep } from "./steps/step";
import { synthesizeCandidates } from "./steps/synthesize-candidates";

export type { PipelineParams } from "./context";

/** One durable instance per pipeline run (AR-10.3, design §5). Orchestration only — the
 *  ordered sequence of steps and gates from spec §1; every step is its own file. */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep): Promise<void> {
    await runPipeline(this.env, step, event.payload);
  }
}

export async function runPipeline(env: Env, step: WorkflowStep, params: PipelineParams): Promise<void> {
  const ctx = createRunContext(env, params);

  try {
    // 1. entry gates — caps, pauses, suspension, pending drafts. A skip is recorded as
    // such; a refusal (cap, rate limit) is a failure with the reason (design §5).
    const entry = await runStep(step, ctx, entryGates, {});
    if (!entry.ok) {
      await runStep(step, ctx, record, { outcome: "skipped", reason: entry.reason, kind: entry.kind }, "skip");
      return;
    }

    // 2. load-profile — pins the profile version for the whole run
    pinProfile(ctx, await runStep(step, ctx, loadProfile, {}));

    // 3. topic — snippet search feeds targeted research (user topic) or synthesis + scoring
    const { results: fetched } = await runStep(step, ctx, search, { query: ctx.userTopic?.title });
    const topic = ctx.userTopic
      ? await runStep(step, ctx, research, { userTopic: ctx.userTopic, fetched })
      : await runStep(step, ctx, score, { candidates: await runStep(step, ctx, synthesizeCandidates, { fetched }) });
    if (!topic) {
      await runStep(step, ctx, record, { outcome: "skipped", reason: "no candidate scored ≥6 (FR-5.2)", kind: "no_topic" }, "no-topic");
      return;
    }

    // 5. angles → angle gate
    const proposals = await runStep(step, ctx, angles, { topic });
    const angle = proposals.angles[await chooseAngle(step, ctx, proposals)]!;

    // 7. draft → 9. save-draft
    const drafted = await runStep(step, ctx, draft, { topic, angle });
    const { id: draftId } = await runStep(step, ctx, saveDraft, { topicId: topic.id, angle, markdown: drafted.article.markdown });

    // 11–13. hero image, Sanity draft, notify → draft gate
    const built = await reviewable(step, ctx, {
      draftId,
      revisionNo: 0,
      article: drafted.article,
      provider: drafted.provider,
      model: drafted.model,
      sourceUrls: topic.sourceUrls,
    });
    const review = await reviewLoop(
      step,
      ctx,
      { draftId, topic, angle, proposals, article: drafted.article, reviewable: built },
      await waitForDraftDecision(step, 0),
    );

    // terminal decision
    switch (review.decision.action) {
      case "approve":
        // edits, blogType, ticked channels → 14–16. derivatives from the final markdown → 17. publish
        await applyGate(step, ctx, draftGate, review.decision);
        await deriveAll(step, ctx, { draftId, revisionNo: ctx.revision, source: review.article });
        await runStep(step, ctx, publish, { draftId, publishMode: review.decision.publishMode ?? "now" });
        return;
      case "reject":
        await runStep(step, ctx, record, {
          outcome: "rejected",
          draftId,
          sanityDocId: review.reviewable.sanityDocId,
          category: review.decision.rejectionCategory ?? "other",
        }, "reject");
        return;
      default:
        await runStep(step, ctx, record, { outcome: "expired", draftId }, "expire");
        return;
    }
  } catch (e) {
    await runStep(step, ctx, record, { outcome: "failed", message: e instanceof Error ? e.message.slice(0, 500) : "unknown" }, "failure");
    throw e;
  }
}
