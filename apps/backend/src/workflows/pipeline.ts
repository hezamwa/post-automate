import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../shared/env";

export interface PipelineParams {
  runId: string;
  userId: string;
  /** Set for user-requested runs (FR-5.8) — replaces discover/score with targeted research. */
  userTopic?: { title: string; notes?: string; links?: string[] };
}

export interface ApprovalEventPayload {
  action: "approve" | "reject" | "revise" | "change_angle" | "expired";
  publishMode?: "now" | "next_slot"; // FR-7.5
  editedMarkdown?: string; // FR-6.9
  instructions?: string; // FR-7.9 (revise)
  angleIndex?: number; // change_angle
  rejectionCategory?: "quality" | "changed_mind" | "other"; // FR-7.8
}

/**
 * One durable instance per pipeline run (AR-10.3, design §5).
 *
 * Step plan (all idempotent, runId-scoped):
 *   gates → load-profile
 *   → [scheduled] discover → score   |   [user_topic] research
 *   → angles (→ waitForEvent "angle-choice" for user-requested runs, 24h → auto-pick)
 *   → draft → derivatives (image, X version, translation)
 *   → create-sanity-draft (deterministic ID: draft-{runId}) → notify
 *   → approval loop: waitForEvent "approval" (7d → expired); revise ≤3× (FR-7.9)
 *   → publish (now) | schedule-publish (next_slot) → record
 */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    // TODO(phase-1): implement per docs/design.md §5. Skeleton keeps the instance valid.
    await step.do("todo-scaffold", async () => {
      console.log("pipeline run started", event.payload.runId, event.payload.userId);
    });
  }
}
