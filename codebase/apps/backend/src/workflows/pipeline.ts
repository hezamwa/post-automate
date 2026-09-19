import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../shared/env";
import { createRunContext, pinProfile, type PipelineParams } from "./context";
import { chooseAngle } from "./gates/angle";
import { applyGate } from "./gates/gate";
import { draftGate, waitForDraftDecision } from "./gates/draft";
import { reviewLoop } from "./loops/revise";
import { angles } from "./steps/angles";
import { createSanityDraftStep } from "./steps/create-sanity-draft";
import { derivatives } from "./steps/derivatives";
import { discover } from "./steps/discover";
import { draft } from "./steps/draft";
import { entryGates } from "./steps/gates";
import { loadProfile } from "./steps/load-profile";
import { notify } from "./steps/notify";
import { publish } from "./steps/publish";
import { record } from "./steps/record";
import { recordDerivativesStep } from "./steps/record-derivatives";
import { research } from "./steps/research";
import { saveDraft } from "./steps/save-draft";
import { score } from "./steps/score";
import { runStep } from "./steps/step";

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

    // 3. topic — discover + score, or targeted research for a user topic
    const topic = ctx.userTopic
      ? await runStep(step, ctx, research, { userTopic: ctx.userTopic })
      : await runStep(step, ctx, score, { candidates: await runStep(step, ctx, discover, {}) });
    if (!topic) {
      await runStep(step, ctx, record, { outcome: "skipped", reason: "no candidate scored ≥6 (FR-5.2)", kind: "no_topic" }, "no-topic");
      return;
    }

    // 5. angles → angle gate
    const proposals = await runStep(step, ctx, angles, { topic });
    const angle = proposals.angles[await chooseAngle(step, ctx, proposals)]!;

    // 7. draft
    const drafted = await runStep(step, ctx, draft, { topic, angle });

    // derivatives (v1 position — after approval once reordered)
    const derived = await runStep(step, ctx, derivatives, { article: drafted.article });

    // 9. save-draft
    const { id: draftId } = await runStep(step, ctx, saveDraft, { topicId: topic.id, angle, markdown: drafted.article.markdown });

    // hero image + Sanity draft (v1: one step) and the per-derivative rows
    const sanity = await runStep(step, ctx, createSanityDraftStep, {
      draftId,
      article: drafted.article,
      texts: derived.texts,
      sourceUrls: topic.sourceUrls,
      provider: drafted.provider,
      model: drafted.model,
      revised: false,
    });
    await runStep(step, ctx, recordDerivativesStep, {
      draftId,
      revisionNo: 0,
      records: [...derived.outcomes, { kind: "hero_image", ...sanity.heroOutcome }],
    });

    // 13. notify → draft gate (with the revise / change_angle loop)
    await runStep(step, ctx, notify, { draftId, title: drafted.article.title, revised: false });
    const review = await reviewLoop(
      step,
      ctx,
      { draftId, topic, angle, proposals, article: drafted.article, sanity },
      await waitForDraftDecision(step, 0),
    );

    // terminal decision
    switch (review.decision.action) {
      case "approve":
        await applyGate(step, ctx, draftGate, review.decision);
        await runStep(step, ctx, publish, { draftId, publishMode: review.decision.publishMode ?? "now" });
        return;
      case "reject":
        await runStep(step, ctx, record, {
          outcome: "rejected",
          draftId,
          sanityDocId: review.sanity.sanityDocId,
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
