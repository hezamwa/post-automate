import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../shared/env";
import { createRunContext, pinProfile, type PipelineParams } from "./context";
import { chooseAngle } from "./gates/angle";
import { resolveDerivatives } from "./gates/derivatives";
import { draftGate, waitForDraftDecision } from "./gates/draft";
import { applyGate, RunAbandonedError } from "./gates/gate";
import { chooseImage } from "./gates/image";
import { chooseOutline } from "./gates/outline";
import { resolvePublish } from "./gates/publish";
import { chooseTopic } from "./gates/topic";
import { deriveAll } from "./loops/derivatives";
import { draftWithQualityCheck } from "./loops/quality";
import { reviewable, reviewLoop, type ReviewState } from "./loops/revise";
import { angles } from "./steps/angles";
import { fetchSourcesStep } from "./steps/fetch-sources";
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

    // 3. topic — snippet search feeds targeted research (user topic) or synthesis + scoring,
    // then the topic gate (pick, free text → research, or auto)
    const { results: fetched } = await runStep(step, ctx, search, { query: ctx.userTopic?.title });
    let topic;
    if (ctx.userTopic) {
      topic = await runStep(step, ctx, research, { userTopic: ctx.userTopic, fetched });
    } else {
      const best = await runStep(step, ctx, score, { candidates: await runStep(step, ctx, synthesizeCandidates, { fetched }) });
      if (!best) {
        await runStep(step, ctx, record, { outcome: "skipped", reason: "no candidate scored ≥6 (FR-5.2)", kind: "no_topic" }, "no-topic");
        return;
      }
      topic = await chooseTopic(step, ctx);
    }

    // 4. fetch-sources — full content for the chosen topic only
    await runStep(step, ctx, fetchSourcesStep, { urls: topic.sourceUrls });

    // 5. angles → angle gate; 6. outline → outline gate
    const { angle, proposals } = await chooseAngle(step, ctx, await runStep(step, ctx, angles, { topic }));
    const outline = await chooseOutline(step, ctx, { topic, angle });

    // 7–8. draft → quality-check (fail → one automatic revise) → 9. save-draft
    const { drafted, quality } = await draftWithQualityCheck(step, ctx, { topic, angle, outline, autoRevise: true });
    const { id: draftId } = await runStep(step, ctx, saveDraft, { topicId: topic.id, angle, markdown: drafted.article.markdown, qualityCheck: quality });

    // 10. image-concepts → image gate; 11–13. hero image, Sanity draft, notify → draft gate
    const concept = await chooseImage(step, ctx, { title: drafted.article.title, excerpt: drafted.article.excerpt });
    const state: ReviewState = {
      draftId,
      topic,
      angle,
      outline,
      proposals,
      article: drafted.article,
      concept,
      reviewable: await reviewable(step, ctx, { draftId, revisionNo: 0, article: drafted.article, provider: drafted.provider, model: drafted.model, sourceUrls: topic.sourceUrls, concept }),
      waits: 0,
    };
    let review = await reviewLoop(step, ctx, state, await waitForDraftDecision(step, state.waits++));

    // approve → derivatives gate (on the approve payload) → 14–16. derivatives → publish gate → 17. publish
    // hold sends the draft back to the queue and the draft gate; every cycle gets its own step names.
    for (let approval = 0; review.decision.action === "approve"; approval++) {
      const tag = approval ? `a${approval}` : undefined;
      const decision = await applyGate(step, ctx, draftGate, review.decision, undefined, tag);
      const edited = decision.editedMarkdown != null && decision.editedMarkdown !== review.article.markdown;
      if (edited) review.article = { ...review.article, markdown: decision.editedMarkdown! };
      await resolveDerivatives(step, ctx, decision, tag);
      await deriveAll(step, ctx, { draftId, revisionNo: ctx.revision, source: review.article, force: edited }, tag);
      const verdict = await resolvePublish(step, ctx, tag);
      if (verdict !== "hold") {
        await runStep(step, ctx, publish, { draftId, publishMode: verdict }, tag);
        return;
      }
      await runStep(step, ctx, record, { outcome: "held" }, `hold${approval + 1}`);
      review = await reviewLoop(step, ctx, { ...state, article: review.article, angle: review.angle, reviewable: review.reviewable }, await waitForDraftDecision(step, state.waits++));
    }

    // reject, or the instance's wait ran out (stale — never expired, spec §5.1)
    if (review.decision.action === "reject") {
      await runStep(step, ctx, record, { outcome: "rejected", draftId, sanityDocId: review.reviewable.sanityDocId, category: review.decision.rejectionCategory ?? "other" }, "reject");
    } else {
      await runStep(step, ctx, record, { outcome: "stale", draftId }, "stale");
    }
  } catch (e) {
    if (e instanceof RunAbandonedError) return; // recorded by the gate; a decision, not a failure
    await runStep(step, ctx, record, { outcome: "failed", message: e instanceof Error ? e.message.slice(0, 500) : "unknown" }, "failure");
    throw e;
  }
}
