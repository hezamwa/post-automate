import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, schema } from "../db/client";
import { getUserById, rejectDraft, scheduleDraft, setRunState } from "../db/commands";
import { computeNextSlot } from "../modules/publishing/schedule";
import { deleteDraft, publishApprovedDraft, retractPublished } from "../modules/publishing";
import { getActiveProfile } from "../modules/profiles";
import type { Env } from "../shared/env";
import type { ApprovalEventPayload } from "../workflows/pipeline";

// Design §7: drafts queue + decisions (FR-7.x). Auth lands in Phase 2 — until then the
// mutating routes refuse in production and take ?email= in dev.

function devOnly(env: Env): string | null {
  return env.ENVIRONMENT === "production" ? "Requires auth (Phase 2) — refused in production" : null;
}

export const drafts = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const email = c.req.query("email");
    if (!email) return c.json({ error: "?email= required until Phase-2 auth" }, 400);
    const db = createDb(c.env);
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
    if (!user) return c.json({ error: "unknown user" }, 404);
    const rows = await db
      .select({
        id: schema.drafts.id,
        runId: schema.drafts.runId,
        status: schema.drafts.status,
        sanityDocumentId: schema.drafts.sanityDocumentId,
        publishAt: schema.drafts.publishAt,
        createdAt: schema.drafts.createdAt,
        decidedAt: schema.drafts.decidedAt,
      })
      .from(schema.drafts)
      .where(eq(schema.drafts.userId, user.id))
      .orderBy(desc(schema.drafts.createdAt))
      .limit(50);
    return c.json({ drafts: rows });
  })

  // {action: approve|reject|revise|change_angle, editedMarkdown?, publishMode?,
  //  instructions?, angleIndex?, rejectionCategory?} (FR-7.5, FR-7.8-7.9)
  .post("/:id/decision", async (c) => {
    const guard = devOnly(c.env);
    if (guard) return c.json({ error: guard }, 501);
    const body = (await c.req.json().catch(() => ({}))) as ApprovalEventPayload;
    if (!["approve", "reject", "revise", "change_angle"].includes(body.action)) {
      return c.json({ error: "action must be approve|reject|revise|change_angle" }, 400);
    }
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, c.req.param("id")) });
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
      if (body.publishMode === "next_slot") {
        const { profile } = await getActiveProfile(db, user.id);
        await scheduleDraft(db, draft.id, computeNextSlot(profile));
        await setRunState(db, draft.runId, "publishing");
      } else {
        await publishApprovedDraft(c.env, db, { user, draftId: draft.id });
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

  // FR-7.8: cancel a scheduled publish before publish_at
  .post("/:id/cancel-schedule", async (c) => {
    const guard = devOnly(c.env);
    if (guard) return c.json({ error: guard }, 501);
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, c.req.param("id")) });
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
    const guard = devOnly(c.env);
    if (guard) return c.json({ error: guard }, 501);
    const db = createDb(c.env);
    const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, c.req.param("id")) });
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (draft.status !== "published" || !draft.sanityDocumentId) {
      return c.json({ error: `draft is ${draft.status}, not published` }, 409);
    }
    const user = await getUserById(db, draft.userId);
    await retractPublished(c.env, { projectId: user.sanityProjectId!, dataset: user.sanityDataset }, draft.sanityDocumentId);
    await db
      .update(schema.drafts)
      .set({ status: "retracted", sanityDocumentId: `drafts.${draft.sanityDocumentId}` })
      .where(eq(schema.drafts.id, draft.id));
    return c.json({ ok: true, nowDraft: `drafts.${draft.sanityDocumentId}` });
  });
