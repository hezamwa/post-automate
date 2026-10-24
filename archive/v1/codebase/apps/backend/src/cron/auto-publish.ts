import { and, eq, isNull, lte } from "drizzle-orm";
import { schema, type Db } from "../db/client";
import { markAutoPublishWarned } from "../db/commands";
import { getProfileVersion } from "../modules/profiles";
import { hasMedicalGuardrails } from "../modules/profiles/medical";
import type { Env } from "../shared/env";
import { notifyUser } from "../shared/notify";
import { approveDirect } from "../workflows/direct";
import { daysSince } from "./activity";

// Auto-publish (spec §5.2): admin-only flag, default off. A draft left pending for 7 days
// is approved and published at the next slot — only when ALL hold: no medical guardrails,
// quality-check passed without a revise, the creator opened the draft at least once, and
// a warning push went out 24 hours earlier with a one-tap Hold that was not acted on.

export const WARN_AFTER_DAYS = 6;
export const PUBLISH_AFTER_DAYS = 7;
const DAY_MS = 24 * 3600_000;

type DraftRow = typeof schema.drafts.$inferSelect;

/** Conditions 1–3, which are about the draft and the profile — null when they hold. */
export async function eligibilityBlocker(db: Db, draft: DraftRow): Promise<string | null> {
  const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });
  if (!run) return "no run";
  const { profile } = await getProfileVersion(db, run.userId, run.profileVersion);
  if (hasMedicalGuardrails(profile)) return "medical guardrails (FR-7.2)";
  const quality = draft.qualityCheck as { passed?: boolean; autoRevised?: boolean } | null;
  if (!quality?.passed || quality.autoRevised) return "quality-check did not pass cleanly";
  if (!draft.seenAt) return "never opened by the creator";
  return null;
}

/** Daily: warn on day 6, publish on day 7 if the warning stood for 24 hours unheld. */
export async function autoPublish(env: Env, db: Db, now = new Date()): Promise<{ warned: string[]; published: string[]; skipped: Array<[string, string]> }> {
  const out = { warned: [] as string[], published: [] as string[], skipped: [] as Array<[string, string]> };
  const enabled = await db.select({ userId: schema.userLimits.userId }).from(schema.userLimits).where(eq(schema.userLimits.autoPublish, true));
  for (const { userId } of enabled) {
    const pending = await db
      .select()
      .from(schema.drafts)
      .where(and(eq(schema.drafts.userId, userId), eq(schema.drafts.status, "pending_approval"), isNull(schema.drafts.autoPublishHeldAt), lte(schema.drafts.createdAt, new Date(now.getTime() - WARN_AFTER_DAYS * DAY_MS))));
    for (const draft of pending) {
      const blocker = await eligibilityBlocker(db, draft);
      if (blocker) {
        out.skipped.push([draft.id, blocker]);
        continue;
      }
      if (!draft.autoPublishWarnedAt) {
        await notifyUser(env, db, userId, {
          title: "Publishing tomorrow unless you hold it",
          body: "This draft has waited a week. It will be published at your next slot in 24 hours — tap Hold to keep it in the queue.",
          data: { draftId: draft.id, runId: draft.runId, action: "hold" },
        });
        await markAutoPublishWarned(db, draft.id, now);
        out.warned.push(draft.id);
        continue;
      }
      const warnedFor = now.getTime() - draft.autoPublishWarnedAt.getTime();
      if (daysSince(draft.createdAt, now) < PUBLISH_AFTER_DAYS || warnedFor < DAY_MS) {
        out.skipped.push([draft.id, "warning has not stood for 24 hours"]);
        continue;
      }
      // the profile decides the derivatives (spec §4.1); published at the next slot by the hourly publisher
      await approveDirect(env, db, { draft, decision: { action: "approve", publishMode: "next_slot" } });
      out.published.push(draft.id);
    }
  }
  return out;
}
