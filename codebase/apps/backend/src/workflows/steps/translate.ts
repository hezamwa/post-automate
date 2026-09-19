import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { recordDerivatives } from "../../db/commands";
import { translateArticle } from "../../modules/generation";
import { DECLINED_REASON, kindDecision } from "../../modules/generation/channels";
import { moduleCtx, profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 16 (FR-6.14, FR-3.13): the target-language edition, one call, after
// approval, from the FINAL markdown — generated once, so it cannot drift from an edited
// article. Not supported by the profile → `absent`, no row; unticked → `declined` (a row,
// no call); requested but unroutable or failing → `failed` with the reason (FR-15.13).
export const translate = defineStep({
  name: "translate",
  input: z.object({
    draftId: z.string().uuid(),
    revisionNo: z.number().int().min(0),
    /** Title/excerpt/alt from the article when known; the prompt writes them otherwise. */
    source: z.object({ title: z.string().optional(), excerpt: z.string().optional(), imageAlt: z.string().optional() }).default({}),
  }),
  output: z.object({ outcome: z.enum(["absent", "declined", "produced", "failed"]), reason: z.string().optional() }),
  bills: "translate",
  retries: RETRY.ai,
  run: async (ctx, { draftId, revisionNo, source }) => {
    const profile = profileOf(ctx);
    const db = createDb(ctx.env);
    const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, draftId) });
    if (!draft?.markdown) throw new Error(`draft ${draftId} has no markdown to translate (DR-9.11)`);
    const decision = kindDecision(profile, draft.channels as string[] | null, "translation");
    if (decision === "absent") return { outcome: "absent" };
    if (decision === "declined") {
      await recordDerivatives(db, draftId, revisionNo, [{ kind: "translation", outcome: "declined", reason: DECLINED_REASON }]);
      return { outcome: "declined" };
    }
    const result = await translateArticle(ctx.env, db, moduleCtx(ctx), { ...source, markdown: draft.markdown }, profile.translation.targetLanguage!);
    await recordDerivatives(db, draftId, revisionNo, [result]);
    return result.outcome === "produced" ? { outcome: "produced" } : { outcome: "failed", reason: result.reason };
  },
});
