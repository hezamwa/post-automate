import type { WorkflowStep } from "cloudflare:workers";
import type { CandidateRef } from "../../modules/discovery/types";
import { findingsAsInstructions } from "../../modules/generation/quality";
import type { Angle, ArticleResult, Outline, QualityCheck } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { draft } from "../steps/draft";
import { qualityCheck } from "../steps/quality-check";
import { runStep } from "../steps/step";

// Spec §3 steps 7–8: draft, then quality-check. On a failed check, ONE automatic revise
// with the findings, then check again and proceed regardless — the findings travel to
// the review screen; the human is the final check (§7). Revisions requested by the
// creator (§5) re-check without the automatic revise (§8: one Sonnet, one Haiku each).

export interface DraftInput {
  topic: CandidateRef;
  angle: Angle;
  outline: Outline | null;
  revision?: { draftId: string; revisionNo: number; instructions?: string; currentMarkdown?: string };
  autoRevise: boolean;
}

export async function draftWithQualityCheck(
  step: WorkflowStep,
  ctx: RunContext,
  input: DraftInput,
  suffix?: string,
): Promise<{ drafted: ArticleResult; quality: QualityCheck }> {
  const { topic, angle, outline } = input;
  const draftId = input.revision?.draftId;
  let drafted = await runStep(step, ctx, draft, { topic, angle, outline, revision: input.revision }, suffix);
  let quality = await runStep(step, ctx, qualityCheck, { article: drafted.article, outline, draftId }, suffix);
  if (!quality.passed && input.autoRevise) {
    const tag = suffix ? `${suffix}-qc` : "qc";
    drafted = await runStep(step, ctx, draft, {
      topic,
      angle,
      outline,
      revision: { instructions: findingsAsInstructions(quality), currentMarkdown: drafted.article.markdown },
    }, tag);
    quality = { ...(await runStep(step, ctx, qualityCheck, { article: drafted.article, outline, draftId }, tag)), autoRevised: true };
  }
  return { drafted, quality };
}
