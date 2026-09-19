import type { WorkflowStep } from "cloudflare:workers";
import type { CandidateRef } from "../../modules/discovery/types";
import type { Angle, AngleProposals, Article } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { type ApprovalEventPayload, waitForDraftDecision } from "../gates/draft";
import { draft } from "../steps/draft";
import { heroImage } from "../steps/hero-image";
import { notify } from "../steps/notify";
import { runStep } from "../steps/step";
import { writeSanityDraft } from "../steps/write-sanity-draft";

// The revise / change_angle loop (spec §5, FR-7.9): at most 3 revisions per draft. Each
// re-drafts, rebuilds the reviewable draft (hero image kept), pushes again and waits for
// the next decision. revise re-enters at `draft` with instructions; change_angle from
// another of the run's stored angles (at `outline` once that step exists).

export const MAX_REVISIONS = 3;

export interface ReviewableInput {
  draftId: string;
  revisionNo: number;
  article: Article;
  provider: string;
  model: string;
  sourceUrls: string[];
  existingAssetRef?: string;
}

export interface Reviewable {
  sanityDocId: string;
  assetRef?: string;
}

/**
 * Everything between the article and the draft gate (spec §3 steps 11–13): hero image,
 * Sanity draft, push. Derivatives come after approval (loops/derivatives.ts).
 */
export async function reviewable(step: WorkflowStep, ctx: RunContext, input: ReviewableInput, suffix?: string): Promise<Reviewable> {
  const { draftId, revisionNo, article } = input;
  const hero = await runStep(step, ctx, heroImage, { draftId, revisionNo, article, existingAssetRef: input.existingAssetRef }, suffix);
  const { sanityDocId } = await runStep(step, ctx, writeSanityDraft, {
    draftId,
    revisionNo,
    article,
    sourceUrls: input.sourceUrls,
    provider: input.provider,
    model: input.model,
    imageAssetId: hero.assetRef,
    revised: revisionNo > 0,
  }, suffix);
  await runStep(step, ctx, notify, { draftId, title: article.title, revised: revisionNo > 0 }, suffix);
  return { sanityDocId, assetRef: hero.assetRef };
}

export interface ReviewState {
  draftId: string;
  topic: CandidateRef;
  angle: Angle;
  proposals: AngleProposals;
  article: Article;
  reviewable: Reviewable;
}

export interface ReviewOutcome {
  decision: ApprovalEventPayload;
  article: Article;
  angle: Angle;
  reviewable: Reviewable;
}

function isRevision(d: ApprovalEventPayload): boolean {
  return d.action === "revise" || d.action === "change_angle";
}

export async function reviewLoop(step: WorkflowStep, ctx: RunContext, state: ReviewState, first: ApprovalEventPayload): Promise<ReviewOutcome> {
  let { article, angle, reviewable: current } = state;
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
    current = await reviewable(step, ctx, {
      draftId: state.draftId,
      revisionNo: rev,
      article,
      provider: revised.provider,
      model: revised.model,
      sourceUrls: state.topic.sourceUrls,
      existingAssetRef: current.assetRef, // image kept unless instructions address it (FR-7.9)
    }, suffix);
    decision = await waitForDraftDecision(step, rev);
  }
  return { decision, article, angle, reviewable: current };
}
