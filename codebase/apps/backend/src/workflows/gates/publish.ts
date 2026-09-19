import type { WorkflowStep } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { getUserById, recordDerivatives } from "../../db/commands";
import { getDraftByRun } from "../../db/queries";
import { latestDerivativeRevision } from "../../modules/generation";
import { patchDraftFields } from "../../modules/publishing";
import type { RunContext } from "../context";
import type { ApprovalEventPayload } from "./draft";
import { defineGate, resolveGate } from "./gate";

// The publish gate (spec §4.3): now / next slot / hold, showing the produced derivative
// texts. `auto` uses the publishMode given at approval. Edits to a derivative text ride
// along with the answer (`edits`) and replace the produced row and the Sanity field.
// hold returns the draft to pending_approval (spec §5 state machine).

export const publishChoiceSchema = z
  .object({
    optionId: z.enum(["now", "next_slot", "hold"]),
    edits: z.object({ x: z.string().max(280).optional(), linkedin: z.string().max(3000).optional() }).strict().optional(),
  })
  .strict();
export type PublishChoice = z.infer<typeof publishChoiceSchema>;

async function producedTexts(ctx: RunContext) {
  const db = createDb(ctx.env);
  const draft = await getDraftByRun(db, ctx.runId);
  if (!draft) return { draft: null, rows: [] as Array<{ kind: string; content: string | null; outcome: string; reason: string | null }> };
  const revisionNo = await latestDerivativeRevision(db, draft.id);
  const rows = await db
    .select({ kind: schema.draftDerivatives.kind, content: schema.draftDerivatives.content, outcome: schema.draftDerivatives.outcome, reason: schema.draftDerivatives.reason })
    .from(schema.draftDerivatives)
    .where(and(eq(schema.draftDerivatives.draftId, draft.id), eq(schema.draftDerivatives.revisionNo, revisionNo), inArray(schema.draftDerivatives.kind, ["x", "linkedin", "translation"])));
  return { draft, rows };
}

export const publishGate = defineGate<PublishChoice>({
  name: "publish",
  options: async (ctx) => {
    const { rows } = await producedTexts(ctx);
    const summary = rows.map((r) => `${r.kind}: ${r.outcome === "produced" ? (r.content ?? "").slice(0, 400) : `${r.outcome}${r.reason ? ` — ${r.reason}` : ""}`}`).join("\n\n") || "article only";
    return {
      options: [
        { id: "now", title: "Publish now", summary, why: "Goes live immediately, with the translated edition if produced." },
        { id: "next_slot", title: "Publish at the next slot", summary, why: "Held for the hourly publisher at your next preferred slot." },
        { id: "hold", title: "Hold", summary, why: "Back to the drafts queue — nothing goes live." },
      ],
      recommended: "now",
    };
  },
  choice: publishChoiceSchema,
  recommended: async (ctx) => ({ optionId: ((ctx.choices.draft as ApprovalEventPayload | undefined)?.publishMode ?? "now") as "now" | "next_slot" }),
  apply: async (ctx, choice) => {
    if (!choice.edits) return;
    const db = createDb(ctx.env);
    const draft = await getDraftByRun(db, ctx.runId);
    if (!draft) return;
    const revisionNo = await latestDerivativeRevision(db, draft.id);
    const fields: Record<string, string> = {};
    for (const [kind, text] of Object.entries(choice.edits) as Array<["x" | "linkedin", string | undefined]>) {
      if (!text) continue;
      await recordDerivatives(db, draft.id, revisionNo, [{ kind, outcome: "produced", content: text }]);
      fields[kind === "x" ? "xVersion" : "linkedinVersion"] = text;
    }
    if (draft.sanityDocumentId && Object.keys(fields).length > 0) {
      await patchDraftFields(ctx.env, await getUserById(db, ctx.userId), draft.sanityDocumentId, fields);
    }
  },
});

/** Resolve the gate (auto = the approval's publishMode) and return the verdict. */
export async function resolvePublish(step: WorkflowStep, ctx: RunContext, suffix?: string): Promise<"now" | "next_slot" | "hold"> {
  return (await resolveGate(step, ctx, publishGate, suffix)).optionId;
}
