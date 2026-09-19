import { z } from "zod";
import { createDb } from "../../db/client";
import { recordDerivatives } from "../../db/commands";
import { translateArticle } from "../../modules/generation";
import { moduleCtx, profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 16 (FR-6.14, FR-3.13): the target-language edition, one call, from the
// final markdown. Not requested by the profile → `absent`, no row (design §5). Requested
// but unroutable or failing → `failed` with the reason, never silently dropped (FR-15.13).
export const translate = defineStep({
  name: "translate",
  input: z.object({
    draftId: z.string().uuid(),
    revisionNo: z.number().int().min(0),
    source: z.object({ title: z.string(), excerpt: z.string(), imageAlt: z.string(), markdown: z.string() }),
  }),
  output: z.object({ outcome: z.enum(["absent", "produced", "failed"]), reason: z.string().optional() }),
  bills: "translate",
  retries: RETRY.ai,
  run: async (ctx, { draftId, revisionNo, source }) => {
    const { translation } = profileOf(ctx);
    if (!translation.enabled || !translation.targetLanguage) return { outcome: "absent" };
    const db = createDb(ctx.env);
    const result = await translateArticle(ctx.env, db, moduleCtx(ctx), source, translation.targetLanguage);
    await recordDerivatives(db, draftId, revisionNo, [result]);
    return result.outcome === "produced" ? { outcome: "produced" } : { outcome: "failed", reason: result.reason };
  },
});
