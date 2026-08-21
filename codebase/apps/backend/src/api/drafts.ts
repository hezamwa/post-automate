import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { GateError } from "../ai/gates";
import { requireAuth, type AuthedEnv } from "../auth/middleware";
import { createDb, schema } from "../db/client";
import { getUserById, rejectDraft, scheduleDraft, setDraftBlogType, setRunState } from "../db/commands";
import { getDraftDetail, listDraftsWithDerivatives } from "../db/queries";
import { dropDraftTranslation, translateDraft } from "../modules/generation";
import { computeNextSlot } from "../modules/publishing/schedule";
import { deleteDraft, publishApprovedDraft, retractPublished, retractTranslatedEdition } from "../modules/publishing";
import { getActiveProfile } from "../modules/profiles";
import type { ApprovalEventPayload } from "../workflows/pipeline";

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
  // (§7's route table lacks a detail route — flagged as a doc gap.)
  .get("/:id", async (c) => {
    const detail = await getDraftDetail(createDb(c.env), c.get("userId"), c.req.param("id"));
    if (!detail) return c.json({ error: "draft not found" }, 404);
    return c.json(detail);
  })

  // {action: approve|reject|revise|change_angle, editedMarkdown?, publishMode?,
  //  instructions?, angleIndex?, rejectionCategory?} (FR-7.5, FR-7.8-7.9)
  .post("/:id/decision", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ApprovalEventPayload;
    if (!["approve", "reject", "revise", "change_angle"].includes(body.action)) {
      return c.json({ error: "action must be approve|reject|revise|change_angle" }, 400);
    }
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
    const run = await db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, draft.runId) });

    // Primary path: the Workflow instance is waiting on the approval event (AR-10.5)
    if (run?.workflowInstanceId) {
      try {
        const instance = await c.env.PIPELINE.get(run.workflowInstanceId);
        await instance.sendEvent({ type: "approval", payload: body });
        return c.json({ ok: true, via: "workflow" });
      } catch (e) {
        console.warn("workflow event delivery failed — direct handling:", e instanceof Error ? e.message : e);
      }
    }
    // Fallback (e.g. draft un-scheduled after its workflow completed): handle directly
    const user = await getUserById(db, draft.userId);
    if (body.action === "approve") {
      if (body.blogType) await setDraftBlogType(db, draft.id, body.blogType);
      if (body.publishMode === "next_slot") {
        // Scheduling is not a publish — allowed under publishing.paused; the hourly
        // publisher holds it until the switch is resumed (FR-15.12b).
        const { profile } = await getActiveProfile(db, user.id);
        await scheduleDraft(db, draft.id, computeNextSlot(profile));
        await setRunState(db, draft.runId, "publishing");
      } else {
        try {
          await publishApprovedDraft(c.env, db, { user, draftId: draft.id });
        } catch (e) {
          if (e instanceof GateError) return c.json({ error: e.message }, 503);
          throw e;
        }
        await setRunState(db, draft.runId, "published");
      }
      return c.json({ ok: true, via: "direct" });
    }
    if (body.action === "reject") {
      if (draft.sanityDocumentId?.startsWith("drafts.")) {
        await deleteDraft(c.env, { projectId: user.sanityProjectId!, dataset: user.sanityDataset }, draft.sanityDocumentId);
      }
      await rejectDraft(db, draft.id, body.rejectionCategory ?? "other");
      await setRunState(db, draft.runId, "rejected", `rejected: ${body.rejectionCategory ?? "other"}`);
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
