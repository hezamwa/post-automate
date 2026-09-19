import type { WorkflowStep } from "cloudflare:workers";
import type { RunContext } from "../context";
import type { AngleProposals } from "../../modules/generation/types";

// The angle gate — v1 semantics (FR-6.3): only user-requested runs wait, 24 hours, for the
// requester's pick; a timeout auto-picks the recommendation. Scheduled/manual runs take
// the recommendation outright. Replaced by resolveGate over profile.gates.angle in the
// gate-framework phase (spec §4.2 — no auto-proceed on timeout after that).

export const ANGLE_EVENT_TYPE = "angle-choice";

function clamp(index: number, count: number): number {
  return Math.min(Math.max(index, 0), count - 1);
}

export async function chooseAngle(step: WorkflowStep, ctx: RunContext, proposals: AngleProposals): Promise<number> {
  let index = proposals.recommendedIndex;
  if (ctx.userTopic) {
    index = await step
      .waitForEvent<{ angleIndex: number }>("angle-choice", { type: ANGLE_EVENT_TYPE, timeout: "24 hours" })
      .then((e) => e.payload.angleIndex)
      .catch(() => proposals.recommendedIndex); // timeout → auto-pick
  }
  const chosen = clamp(index, proposals.angles.length);
  ctx.choices.angle = chosen;
  return chosen;
}
