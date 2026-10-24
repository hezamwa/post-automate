import { z } from "zod";
import { createDb } from "../../db/client";
import { setDraftQuality } from "../../db/commands";
import { recentTopicTitles } from "../../modules/discovery";
import { checkQuality } from "../../modules/generation";
import { articleSchema, outlineSchema, qualityCheckSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 8: the finished article checked — disclaimer, medical language, language,
// length, banned topics, 30-day similarity, outline honoured. One judge call plus the
// deterministic checks. A draft row, when there is one, keeps the latest verdict.
export const qualityCheck = defineStep({
  name: "quality-check",
  input: z.object({ article: articleSchema, outline: outlineSchema.nullable(), draftId: z.string().uuid().optional() }),
  output: qualityCheckSchema,
  bills: "quality_check",
  retries: RETRY.ai,
  run: async (ctx, { article, outline, draftId }) => {
    const db = createDb(ctx.env);
    const result = await checkQuality(ctx.env, db, moduleCtx(ctx), { article, outline, recentTopics: await recentTopicTitles(db, ctx.userId) });
    if (draftId) await setDraftQuality(db, draftId, result);
    return result;
  },
});
