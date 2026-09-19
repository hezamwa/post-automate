import type { WorkflowStep } from "cloudflare:workers";
import type { RunContext } from "../context";
import { runChannel } from "../steps/derive-channel";
import { deriveLinkedIn } from "../steps/derive-linkedin";
import { deriveX } from "../steps/derive-x";
import { runStep } from "../steps/step";
import { translate } from "../steps/translate";

// Spec §3 steps 14–16, after approval: X, LinkedIn, then the translated edition — each
// its own step, each reading the FINAL markdown and the approved channels from the draft.
// Shared by the workflow and by direct handling of a draft whose instance is gone (§5.1).

export interface DeriveAllInput {
  draftId: string;
  revisionNo: number;
  source?: { title?: string; excerpt?: string; imageAlt?: string };
}

export async function deriveAll(step: WorkflowStep, ctx: RunContext, input: DeriveAllInput, suffix?: string): Promise<void> {
  const { draftId, revisionNo } = input;
  await runChannel(step, ctx, deriveX, { draftId, revisionNo }, suffix);
  await runChannel(step, ctx, deriveLinkedIn, { draftId, revisionNo }, suffix);
  await runStep(step, ctx, translate, { draftId, revisionNo, source: input.source ?? {} }, suffix);
}
