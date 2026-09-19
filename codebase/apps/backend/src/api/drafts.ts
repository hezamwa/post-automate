import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { GateError } from "../ai/gates";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb, schema } from "../db/client";
import { getUserById, holdAutoPublish, markDraftSeen, setRunState } from "../db/commands";
import { getDraftDetail, listDraftsWithDerivatives } from "../db/queries";
import { dropDraftTranslation, translateDraft } from "../modules/generation";
import { retractPublished, retractTranslatedEdition } from "../modules/publishing";
import { getActiveProfile } from "../modules/profiles";
import { approveDirect, rejectDirect, runContextFor } from "../workflows/direct";
import { derivativesGate } from "../workflows/gates/derivatives";
import { approvalSchema, DRAFT_EVENT_TYPE } from "../workflows/gates/draft";
import { gateEventType } from "../workflows/gates/wait";
import { profileOf } from "../workflows/context";

// Design §7: drafts queue + decisions (FR-7.x). JWT-authenticated (FR-2.2); every
// query is scoped to the authenticated user, and a foreign draft reads as 404 —
// users only ever see and act on their own records (FR-2.3).

export const drafts = new Hono<AuthedEnv>()
  .use("*", requireAuth)
  // Queue with per-draft derivative outcomes at the latest revision (DR-9.14) — the
  // review screen renders each kind, including WHY one is skipped vs failed. Bodies
  // are fetched live from Sanity (DR-9.6), never duplicated here.
  .get("/", async (c) => {
    const rows = await listDraftsWithDerivatives(createDb(c.env), c.get("userId"));
    return c.json({ drafts: rows });
  })

  // Review-screen detail: markdown (the app's editing source of truth until publish,
  // DR-9.11), latest derivatives, and the run's stored angle proposals (FR-7.9).
  .get("/:id", async (c) => {
    const db = createDb(c.env);
    const detail = await getDraftDetail(db, c.get("userId"), c.req.param("id"));
    if (!detail) return c.json({ error: "draft not found" }, 404);
    // Spec §5.2: the first open by the owner is recorded — auto-publish and reminders read it.
    if (!detail.draft.seenAt) await markDraftSeen(db, detail.draft.id);
    // Spec §4.1: the derivatives gate is rendered on the approve screen — the supported kinds,
    // pre-ticked, and whether the creator sees them at all (auto = the profile decides).
    const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, detail.draft.runId) });
    const ctx = run ? await runContextFor(c.env, db, run).catch(() => null) : null;
    const gates = ctx
      ? { derivatives: { setting: profileOf(ctx).gates.derivatives, ...(await derivativesGate.options(ctx)) }, publish: { setting: profileOf(ctx).gates.publish } }
      : null;
    // Spec §5.2: read-only for the creator — the admin flag, and this draft's warning/hold state.
    const limits = await db.query.userLimits.findFirst({ where: eq(schema.userLimits.userId, c.get("userId")) });
    return c.json({ ...detail, gates, autoPublish: limits?.autoPublish ?? false });
  })

  // {action: approve|reject|revise|change_angle, editedMarkdown?, publishMode?, channels?,
  //  instructions?, angleIndex?, rejectionCategory?, blogType?} (FR-7.5, FR-7.8-7.9).
  // `channels` is the derivatives gate — ticked on the approve screen (spec §4.1).
  .post("/:id/decision", async (c) => {
    const parsed = approvalSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || parsed.data.action === "timeout") {
      const detail = parsed.success ? "" : ` (${parsed.error.issues[0]?.message ?? "invalid body"})`;
      return c.json({ error: `action must be approve|reject|revise|change_angle${detail}` }, 400);
    }
    const body = parsed.data;
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status !== "pending_approval") {
      return c.json({ error: `draft is ${draft.status}, not pending_approval` }, 409);
    }
    if (body.action === "revise") {
      const [n] = await db
        .select({ n: count() })
        .from(schema.draftRevisions)
        .where(eq(schema.draftRevisions.draftId, draft.id));
      if ((n?.n ?? 0) >= 3) return c.json({ error: "revision limit (3) reached — edit manually or reject (FR-7.9)" }, 409);
    }
    // Spec §5.1: a stale draft has no instance to re-enter — only approve, edit and reject
    // still work (direct handling); revise and change_angle are greyed out.
    if (draft.stale && (body.action === "revise" || body.action === "change_angle")) {
      return c.json(
        { error: "This draft waited so long that its pipeline run has ended. Revise and change-angle need a live run — approve it (with edits if you like) or reject it instead (spec §5.1)." },
        409,
      );
    }
    const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });

    // Primary path: the Workflow instance is waiting on the approval event (AR-10.5)
    if (!draft.stale && run?.workflowInstanceId) {
      try {
        const instance = await c.env.PIPELINE.get(run.workflowInstanceId);
        await instance.sendEvent({ type: DRAFT_EVENT_TYPE, payload: body });
        return c.json({ ok: true, via: "workflow" });
      } catch (e) {
        console.warn("workflow event delivery failed — direct handling:", e instanceof Error ? e.message : e);
      }
    }
    // Fallback (instance gone — spec §5.1): the same steps the workflow runs, inline.
    // Scheduling is not a publish and is allowed under publishing.paused; publishing now
    // is refused at the Sanity write (FR-15.12b).
    if (body.action === "approve") {
      try {
        const status = await approveDirect(c.env, db, { draft, decision: body });
        return c.json({ ok: true, via: "direct", status });
      } catch (e) {
        if (e instanceof GateError) return c.json({ error: e.message }, 503);
        throw e;
      }
    }
    if (body.action === "reject") {
      await rejectDirect(c.env, db, { draft, category: body.rejectionCategory ?? "other" });
      return c.json({ ok: true, via: "direct" });
    }
    return c.json({ error: "revise/change_angle need a live workflow instance" }, 409);
  })

  // FR-6.14 per-draft translation override, both directions (design §7): POST requests a
  // translation for a draft whose profile has translation off; DELETE drops the one the
  // profile produced. Standalone against the `translate` route — never re-enters the
  // Workflow. Refused once the draft is published.
  .post("/:id/derivatives/translation", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { targetLanguage?: string };
    if (body.targetLanguage !== "ar" && body.targetLanguage !== "en") {
      return c.json({ error: "Body must include { targetLanguage: 'ar' | 'en' } (FR-6.14)." }, 400);
    }
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status === "published" || draft.status === "retracted") {
      return c.json({ error: `Refused: draft is ${draft.status} — translation overrides apply before publish (FR-6.14).` }, 409);
    }
    if (!draft.markdown) {
      return c.json({ error: `draft is ${draft.status} and its markdown is purged (DR-9.11) — nothing to translate` }, 409);
    }
    const { profile } = await getActiveProfile(db, c.get("userId"));
    if (body.targetLanguage === profile.primaryLanguage) {
      return c.json({ error: "targetLanguage must differ from the profile's primaryLanguage (FR-3.13)." }, 400);
    }
    try {
      const derivative = await translateDraft(c.env, db, {
        draftId: draft.id,
        runId: draft.runId,
        userId: c.get("userId"),
        markdown: draft.markdown,
        title: (draft.angle as { headline?: string } | null)?.headline,
        targetLanguage: body.targetLanguage,
      });
      // outcome may be `failed` (e.g. no enabled translate route) — recorded and returned
      // with the reason rather than dropped silently (FR-15.13)
      return c.json({ derivative });
    } catch (e) {
      if (e instanceof GateError) return c.json({ error: e.message }, 503); // caps/pauses never bypassed (FR-7.7)
      throw e;
    }
  })
  .delete("/:id/derivatives/translation", async (c) => {
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status === "published" || draft.status === "retracted") {
      return c.json({ error: `Refused: draft is ${draft.status} — translation overrides apply before publish (FR-6.14).` }, 409);
    }
    const dropped = await dropDraftTranslation(db, draft.id);
    if (!dropped) return c.json({ error: "this draft has no translation at its current revision" }, 404);
    return c.json({ ok: true });
  })

  // Spec §4.3 / brief §6: the publish gate's hold, from the draft — back to the queue, nothing goes live.
  .post("/:id/hold", async (c) => {
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });
    if (run?.gate === "publish" && run.workflowInstanceId) {
      try {
        const instance = await c.env.PIPELINE.get(run.workflowInstanceId);
        await instance.sendEvent({ type: gateEventType("publish"), payload: { optionId: "hold" } });
        return c.json({ ok: true, via: "workflow" });
      } catch {
        return c.json({ error: "the run's instance is not reachable" }, 409);
      }
    }
    // Spec §5.2: the one-tap Hold on the auto-publish warning — this draft stays in the queue.
    if (draft.status === "pending_approval" && draft.autoPublishWarnedAt) {
      await holdAutoPublish(db, draft.id);
      return c.json({ ok: true, via: "auto-publish" });
    }
    return c.json({ error: "this draft is not waiting at the publish gate and has no auto-publish warning to hold" }, 409);
  })

  // FR-7.8: cancel a scheduled publish before publish_at
  .post("/:id/cancel-schedule", async (c) => {
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status !== "scheduled") return c.json({ error: `draft is ${draft.status}, not scheduled` }, 409);
    await db
      .update(schema.drafts)
      .set({ status: "pending_approval", publishAt: null, publishMode: null })
      .where(eq(schema.drafts.id, draft.id));
    await setRunState(db, draft.runId, "pending_approval");
    return c.json({ ok: true });
  })

  // FR-7.6: urgent retract (unpublish) of a published post
  .post("/:id/retract", async (c) => {
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({
      where: and(eq(schema.drafts.id, c.req.param("id")), eq(schema.drafts.userId, c.get("userId"))),
    });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status !== "published" || !draft.sanityDocumentId) {
      return c.json({ error: `draft is ${draft.status}, not published` }, 409);
    }
    const user = await getUserById(db, draft.userId);
    const target = { projectId: user.sanityProjectId!, dataset: user.sanityDataset };
    await retractPublished(c.env, target, draft.sanityDocumentId);
    await retractTranslatedEdition(c.env, db, target, { id: draft.id, runId: draft.runId }); // FR-7.6 covers both editions
    await db
      .update(schema.drafts)
      .set({ status: "retracted", sanityDocumentId: `drafts.${draft.sanityDocumentId}` })
      .where(eq(schema.drafts.id, draft.id));
    return c.json({ ok: true, nowDraft: `drafts.${draft.sanityDocumentId}` });
  });
