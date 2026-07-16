import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { profileSchema } from "@post-automate/shared";
import { assertRunnable, SkipRunError } from "../ai/gates";
import { createDb } from "../db/client";
import { createDraft, setRunState } from "../db/commands";
import {
  findTopics,
  researchTopic,
  scoreAndSelect,
  type CandidateRef,
} from "../modules/discovery";
import {
  ComplianceRefusalError,
  deriveTexts,
  proposeAngles,
  writeArticle,
} from "../modules/generation";
import { getActiveProfile } from "../modules/profiles";
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

const RETRY = { retries: { limit: 2, delay: "30 seconds" as const, backoff: "exponential" as const } };

/** One durable instance per pipeline run (AR-10.3, design §5). Steps are idempotent
 *  and runId-scoped; step returns must be small JSON (image bytes never cross steps). */
export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  override async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { runId, userId, userTopic } = event.payload;
    const env = this.env;

    // ── gates (design §10; FR-7.4/15.8/15.10) ────────────────────────────────
    const gate = await step.do("gates", async () => {
      const db = createDb(env);
      try {
        await assertRunnable(db, userId, { runId, userRequested: !!userTopic });
        return { ok: true as const, skip: "" };
      } catch (e) {
        if (e instanceof SkipRunError) return { ok: false as const, skip: e.reason };
        throw new NonRetryableError(e instanceof Error ? e.message : "gate refused the run");
      }
    });
    if (!gate.ok) {
      await step.do("record-skip", async () => setRunState(createDb(env), runId, "skipped", gate.skip));
      return;
    }

    try {
      const rawProfile = await step.do("load-profile", async () => {
        const db = createDb(env);
        const { profile } = await getActiveProfile(db, userId);
        return profile;
      });
      const profile = profileSchema.parse(rawProfile); // re-validate after step (de)serialization
      const ctx = { userId, runId, profile };

      // ── topic: discover+score (cron/manual) or targeted research (user) ────
      let topic: CandidateRef | null;
      if (userTopic) {
        topic = await step.do("research", RETRY, async () =>
          researchTopic(env, createDb(env), ctx, userTopic),
        );
      } else {
        const candidates = await step.do("discover", RETRY, async () =>
          findTopics(env, createDb(env), ctx),
        );
        await step.do("state-scoring", async () => setRunState(createDb(env), runId, "scoring"));
        topic = await step.do("score", RETRY, async () =>
          scoreAndSelect(env, createDb(env), ctx, candidates),
        );
      }
      if (!topic) {
        await step.do("record-no-topic", async () =>
          setRunState(createDb(env), runId, "skipped", "no candidate scored ≥6 (FR-5.2)"),
        );
        return;
      }
      const picked = topic;

      await step.do("state-drafting", async () => setRunState(createDb(env), runId, "drafting"));

      // ── angles (FR-6.3): auto-pick for scheduled runs; requester picks for user runs ──
      const angleResult = await step.do("angles", RETRY, async () =>
        proposeAngles(env, createDb(env), ctx, picked),
      );
      let angleIndex = angleResult.recommendedIndex;
      if (userTopic) {
        angleIndex = await step
          .waitForEvent<{ angleIndex: number }>("angle-choice", {
            type: "angle-choice",
            timeout: "24 hours",
          })
          .then((e) => e.payload.angleIndex)
          .catch(() => angleResult.recommendedIndex); // timeout → auto-pick
        angleIndex = Math.min(Math.max(angleIndex, 0), angleResult.angles.length - 1);
      }
      const angle = angleResult.angles[angleIndex]!;

      // ── article (FR-6.3 step 2; guardrails + CANNOT_COMPLY hard-fail) ───────
      const article = await step.do("draft", RETRY, async () => {
        try {
          return await writeArticle(env, createDb(env), ctx, picked, angle);
        } catch (e) {
          if (e instanceof ComplianceRefusalError) throw new NonRetryableError(e.message);
          throw e;
        }
      });

      // ── text derivatives (FR-6.12/6.14); hero image happens at Sanity-write time ──
      const texts = await step.do("derivatives", RETRY, async () =>
        deriveTexts(env, createDb(env), ctx, article),
      );

      const draft = await step.do("save-draft", async () =>
        createDraft(createDb(env), {
          runId,
          userId,
          topicId: picked.id,
          angle,
          markdown: article.markdown,
        }),
      );

      // TODO(module 5): create-sanity-draft (hero image generate+upload in-step, FR-6.13;
      // per-site mapper, FR-8.2), FCM notify, approval loop with revise ≤3 (FR-7.9),
      // publish now / next slot (FR-7.5), record.
      await step.do("state-pending", async () =>
        setRunState(createDb(env), runId, "pending_approval"),
      );
      console.log("pipeline: draft ready", { runId, draftId: draft.id, derivatives: Object.keys(texts) });
    } catch (e) {
      await step.do("record-failure", async () =>
        setRunState(createDb(env), runId, "failed", e instanceof Error ? e.message.slice(0, 500) : "unknown"),
      );
      throw e;
    }
  }
}
