import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { schema } from "../../src/db/client";
import { autoPublish } from "../../src/cron/auto-publish";
import { techProfile } from "../fixtures";
import { draftRow, env, seedDraftRow, startRun } from "../workflow/harness";

// Auto-publish (spec §5.2): warn on day 6, publish at the next slot on day 7 — only when
// ALL four conditions hold. Never for a medical profile.
beforeEach(resetShared);

const DAY = 24 * 3600_000;
const now = new Date("2026-09-20T06:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const passed = { passed: true, autoRevised: false, findings: [] };

async function draftFor(opts: { profile?: ReturnType<typeof techProfile>; flag?: boolean; ageDays?: number; seen?: boolean; quality?: unknown; warnedDaysAgo?: number; held?: boolean } = {}) {
  const params = await startRun({ profile: opts.profile });
  await shared.db.update(schema.userLimits).set({ autoPublish: opts.flag ?? true }).where(eq(schema.userLimits.userId, params.userId));
  const docId = `drafts.postauto-${params.runId}`;
  shared.sanity.docs.set(docId, { _id: docId, _type: "post" });
  const draftId = await seedDraftRow(params, {
    sanityDocumentId: docId,
    createdAt: daysAgo(opts.ageDays ?? 7),
    seenAt: opts.seen === false ? null : daysAgo(2),
    qualityCheck: opts.quality === undefined ? passed : opts.quality,
    autoPublishWarnedAt: opts.warnedDaysAgo == null ? null : daysAgo(opts.warnedDaysAgo),
    autoPublishHeldAt: opts.held ? daysAgo(0.5) : null,
  });
  return { params, draftId };
}

describe("autoPublish", () => {
  it("day 6, eligible: warns once with a Hold action and records it — nothing published yet", async () => {
    const { params, draftId } = await draftFor({ ageDays: 6 });
    const first = await autoPublish(env, shared.db, now);
    expect(first).toMatchObject({ warned: [draftId], published: [] });
    expect(shared.pushes[0]).toMatchObject({ title: "Publishing tomorrow unless you hold it", data: { draftId, action: "hold" } });
    expect((await draftRow(params.runId))?.autoPublishWarnedAt).toEqual(now);
    // same day again: the warning has not stood for 24 hours
    const again = await autoPublish(env, shared.db, new Date(now.getTime() + 3600_000));
    expect(again.published).toEqual([]);
    expect(again.skipped).toEqual([[draftId, "warning has not stood for 24 hours"]]);
    expect(shared.pushes).toHaveLength(1);
  });

  it("day 7 with a day-old warning: approved with the profile's channels and scheduled for the next slot", async () => {
    const { params, draftId } = await draftFor({ ageDays: 7, warnedDaysAgo: 1 });
    expect((await autoPublish(env, shared.db, now)).published).toEqual([draftId]);
    expect(await draftRow(params.runId)).toMatchObject({ status: "scheduled", channels: ["x", "linkedin"] });
    expect(shared.ai.callsFor("shorten_x")).toHaveLength(1); // derivatives from the final text, profile decides
  });

  it("the creator's Hold stops it; so does a missing flag", async () => {
    const held = await draftFor({ ageDays: 7, warnedDaysAgo: 1, held: true });
    const off = await draftFor({ ageDays: 7, warnedDaysAgo: 1, flag: false });
    const out = await autoPublish(env, shared.db, now);
    expect(out.published).toEqual([]);
    expect((await draftRow(held.params.runId))?.status).toBe("pending_approval");
    expect((await draftRow(off.params.runId))?.status).toBe("pending_approval");
  });

  it("never publishes — and never even warns — when a condition fails: medical, quality revised, unseen", async () => {
    const medical = techProfile({
      domain: { field: "medical", subNiches: ["emergency medicine"] },
      compliance: { noDiagnosis: true, noDosage: true, noCaseReferences: true, disclaimerText: "General information only." },
    });
    const m = await draftFor({ profile: medical, ageDays: 7, warnedDaysAgo: 1 });
    const revised = await draftFor({ ageDays: 7, warnedDaysAgo: 1, quality: { passed: true, autoRevised: true, findings: [] } });
    const failed = await draftFor({ ageDays: 7, warnedDaysAgo: 1, quality: { passed: false, autoRevised: false, findings: [] } });
    const unseen = await draftFor({ ageDays: 7, warnedDaysAgo: 1, seen: false });
    const out = await autoPublish(env, shared.db, now);
    expect(out.published).toEqual([]);
    expect(out.warned).toEqual([]);
    expect(Object.fromEntries(out.skipped)).toEqual({
      [m.draftId]: "medical guardrails (FR-7.2)",
      [revised.draftId]: "quality-check did not pass cleanly",
      [failed.draftId]: "quality-check did not pass cleanly",
      [unseen.draftId]: "never opened by the creator",
    });
    expect(shared.pushes).toEqual([]);
  });
});
