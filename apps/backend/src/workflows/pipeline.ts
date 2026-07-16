import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { profileSchema } from "@post-automate/shared";
import { assertRunnable, SkipRunError } from "../ai/gates";
import { createDb } from "../db/client";
import {
  addDraftRevision,
  addEditDiff,
  createDraft,
  expireDraft,
  getUserById,
  rejectDraft,
  scheduleDraft,
  setDraftStatus,
  setRunState,
  updateDraftMarkdown,
} from "../db/commands";
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
import {
  createSanityDraft,
  deleteDraft,
  patchDraftMarkdown,
  publishApprovedDraft,
} from "../modules/publishing";
import { computeNextSlot } from "../modules/publishing/schedule";
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

async function waitForApproval(step: WorkflowStep, n: number): Promise<ApprovalEventPayload> {
  try {
    const event = await step.waitForEvent<ApprovalEventPayload>(`approval-${n}`, {
      type: "approval",
      timeout: "7 days",
    });
    return event.payload;
  } catch {
    return { action: "expired" }; // FR-7.x: 7-day timeout
  }
}

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
      const { article, provider, model } = await step.do("draft", RETRY, async () => {
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

      // ── reviewable Sanity draft: hero image + per-site mapping, all in-step (FR-6.13/8.1-8.3) ──
      const sanity = await step.do("create-sanity-draft", RETRY, async () => {
        const db = createDb(env);
        const user = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, userId) });
        if (!user) throw new NonRetryableError(`user ${userId} not found`);
        return createSanityDraft(env, db, {
          user,
          profile,
          runId,
          draftId: draft.id,
          article,
          texts,
          sourceUrls: picked.sourceUrls,
          provider,
          model,
        });
      });

      await step.do("notify", async () => {
        // TODO(phase-2): FCM push "draft ready for review" (FR-7.1)
        console.log("pipeline: draft ready for review", { runId, sanityDocId: sanity.sanityDocId });
      });

      await step.do("state-pending", async () =>
        setRunState(createDb(env), runId, "pending_approval"),
      );

      // ── approval loop (AR-10.5; FR-7.1/7.5/7.8/7.9): pause ≤7d, revise/change-angle ≤3× ──
      let currentArticle = article;
      let decision = await waitForApproval(step, 0);
      for (let rev = 1; (decision.action === "revise" || decision.action === "change_angle") && rev <= 3; rev++) {
        const priorMarkdown = currentArticle.markdown;
        const instructions = decision.instructions ?? "";
        const chosenAngleIndex = decision.angleIndex;
        const isAngleChange = decision.action === "change_angle";

        const revised = await step.do(`revise-${rev}`, RETRY, async () => {
          const db = createDb(env);
          await setDraftStatus(db, draft.id, "revising");
          if (isAngleChange) {
            const idx = Math.min(Math.max(chosenAngleIndex ?? 0, 0), angleResult.angles.length - 1);
            return writeArticle(env, db, ctx, picked, angleResult.angles[idx]!);
          }
          await addDraftRevision(db, { draftId: draft.id, revisionNo: rev, instructions });
          return writeArticle(env, db, ctx, picked, angle, {
            currentMarkdown: priorMarkdown,
            instructions,
          });
        });
        currentArticle = revised.article;

        const revisedTexts = await step.do(`rederive-${rev}`, RETRY, async () =>
          deriveTexts(env, createDb(env), ctx, revised.article),
        );

        await step.do(`update-sanity-${rev}`, RETRY, async () => {
          const db = createDb(env);
          const user = await getUserById(db, userId);
          await updateDraftMarkdown(db, draft.id, revised.article.markdown);
          await createSanityDraft(env, db, {
            user,
            profile,
            runId,
            draftId: draft.id,
            article: revised.article,
            texts: revisedTexts,
            sourceUrls: picked.sourceUrls,
            provider: revised.provider,
            model: revised.model,
            existingImageAssetId: sanity.imageAssetId, // image kept unless instructions address it (FR-7.9)
          });
          await setDraftStatus(db, draft.id, "pending_approval");
        });
        await step.do(`notify-rev-${rev}`, async () => {
          console.log("pipeline: revised draft ready", { runId, rev });
        });
        decision = await waitForApproval(step, rev);
      }

      // ── terminal decision ────────────────────────────────────────────────────
      if (decision.action === "approve") {
        const edited = decision.editedMarkdown;
        if (edited && edited !== currentArticle.markdown) {
          const before = currentArticle.markdown;
          await step.do("apply-edits", RETRY, async () => {
            const db = createDb(env);
            await addEditDiff(db, { draftId: draft.id, userId, before, after: edited }); // FR-6.9
            await updateDraftMarkdown(db, draft.id, edited);
            const user = await getUserById(db, userId);
            await patchDraftMarkdown(env, user, sanity.sanityDocId, edited);
          });
        }
        if (decision.publishMode === "next_slot") {
          await step.do("schedule-publish", async () => {
            const db = createDb(env);
            await scheduleDraft(db, draft.id, computeNextSlot(profile)); // hourly cron publishes (FR-7.5)
            await setRunState(db, runId, "publishing");
          });
        } else {
          await step.do("publish", RETRY, async () => {
            const db = createDb(env);
            const user = await getUserById(db, userId);
            await publishApprovedDraft(env, db, { user, draftId: draft.id }); // production-only (FR-8.5)
            await setRunState(db, runId, "published");
          });
        }
      } else if (decision.action === "reject") {
        const category = decision.rejectionCategory ?? "other";
        await step.do("reject-cleanup", async () => {
          const db = createDb(env);
          const user = await getUserById(db, userId);
          await deleteDraft(
            env,
            { projectId: user.sanityProjectId!, dataset: user.sanityDataset },
            sanity.sanityDocId,
          ); // FR-7.8: Sanity draft removed
          await rejectDraft(db, draft.id, category);
          await setRunState(db, runId, "rejected", `rejected: ${category}`);
        });
      } else {
        await step.do("expire", async () => {
          const db = createDb(env);
          await expireDraft(db, draft.id); // Sanity draft stays for manual handling (design §5)
          await setRunState(db, runId, "expired", "7-day approval timeout");
        });
      }
    } catch (e) {
      await step.do("record-failure", async () =>
        setRunState(createDb(env), runId, "failed", e instanceof Error ? e.message.slice(0, 500) : "unknown"),
      );
      throw e;
    }
  }
}
