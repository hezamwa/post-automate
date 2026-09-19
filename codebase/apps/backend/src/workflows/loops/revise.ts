import type { WorkflowStep } from "cloudflare:workers";
import type { CandidateRef } from "../../modules/discovery/types";
import type { Angle, AngleProposals, Article } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { type ApprovalEventPayload, waitForDraftDecision } from "../gates/draft";
import { createSanityDraftStep } from "../steps/create-sanity-draft";
import { derivatives } from "../steps/derivatives";
import { draft } from "../steps/draft";
import { notify } from "../steps/notify";
import { recordDerivativesStep } from "../steps/record-derivatives";
import { runStep } from "../steps/step";

// The revise / change_angle loop (spec §5, FR-7.9): at most 3 revisions per draft, each
// one re-drafts, re-derives (v1 position — moves after approval later), rewrites the
// Sanity draft keeping the hero image, pushes again and waits for the next decision.
// revise re-enters at `draft` with instructions; change_angle re-enters from another of
// the run's stored angles (at `outline` once that step exists).

export const MAX_REVISIONS = 3;

export interface ReviewState {
  draftId: string;
  topic: CandidateRef;
  angle: Angle;
  proposals: AngleProposals;
  article: Article;
  sanity: { sanityDocId: string; imageAssetId?: string };
}

export interface ReviewOutcome {
  decision: ApprovalEventPayload;
  article: Article;
  angle: Angle;
  sanity: ReviewState["sanity"];
}

function isRevision(d: ApprovalEventPayload): boolean {
  return d.action === "revise" || d.action === "change_angle";
}

export async function reviewLoop(
  step: WorkflowStep,
  ctx: RunContext,
  state: ReviewState,
  first: ApprovalEventPayload,
): Promise<ReviewOutcome> {
  let { article, angle, sanity } = state;
  let decision = first;
  let rev = 0;
  while (isRevision(decision)) {
    rev++;
    if (rev > MAX_REVISIONS) {
      // The API refuses a 4th revise (FR-7.9); if one slips through, keep waiting for a
      // terminal decision rather than treating it as anything else.
      decision = await waitForDraftDecision(step, rev);
      continue;
    }
    ctx.revision = rev;
    const suffix = `rev${rev}`;
    const changingAngle = decision.action === "change_angle";
    if (changingAngle) {
      const idx = Math.min(Math.max(decision.angleIndex ?? 0, 0), state.proposals.angles.length - 1);
      angle = state.proposals.angles[idx]!;
    }

    const revised = await runStep(step, ctx, draft, {
      topic: state.topic,
      angle,
      revision: {
        draftId: state.draftId,
        revisionNo: rev,
        ...(changingAngle ? {} : { instructions: decision.instructions ?? "", currentMarkdown: article.markdown }),
      },
    }, suffix);
    article = revised.article;

    const derived = await runStep(step, ctx, derivatives, { article }, suffix);
    const written = await runStep(step, ctx, createSanityDraftStep, {
      draftId: state.draftId,
      article,
      texts: derived.texts,
      sourceUrls: state.topic.sourceUrls,
      provider: revised.provider,
      model: revised.model,
      existingImageAssetId: sanity.imageAssetId, // image kept unless instructions address it (FR-7.9)
      revised: true,
    }, suffix);
    sanity = { sanityDocId: written.sanityDocId, imageAssetId: written.imageAssetId };
    await runStep(step, ctx, recordDerivativesStep, {
      draftId: state.draftId,
      revisionNo: rev,
      records: [...derived.outcomes, { kind: "hero_image", ...written.heroOutcome }],
    }, suffix);
    await runStep(step, ctx, notify, { draftId: state.draftId, title: article.title, revised: true }, suffix);

    decision = await waitForDraftDecision(step, rev);
  }
  return { decision, article, angle, sanity };
}
