import { z } from "zod";
import { createDb } from "../../db/client";
import { getUserById, setDraftStatus, updateDraftMarkdown } from "../../db/commands";
import { articleSchema, derivedTextsSchema, heroOutcomeSchema } from "../../modules/generation/types";
import { createSanityDraft } from "../../modules/publishing";
import { profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// TEMPORARY (v1 behaviour): hero image + Sanity document in one step. Replaced by
// hero-image + write-sanity-draft in the splits phase (spec §3 steps 11–12).
export const createSanityDraftStep = defineStep({
  name: "create-sanity-draft",
  input: z.object({
    draftId: z.string().uuid(),
    article: articleSchema,
    texts: derivedTextsSchema,
    sourceUrls: z.array(z.string()),
    provider: z.string(),
    model: z.string(),
    /** Revisions keep the existing hero unless instructions address it (FR-7.9). */
    existingImageAssetId: z.string().optional(),
    revised: z.boolean(),
  }),
  output: z.object({ sanityDocId: z.string(), imageAssetId: z.string().optional(), heroOutcome: heroOutcomeSchema }),
  bills: "image",
  retries: RETRY.ai,
  run: async (ctx, input) => {
    const db = createDb(ctx.env);
    const user = await getUserById(db, ctx.userId);
    if (input.revised) await updateDraftMarkdown(db, input.draftId, input.article.markdown);
    const result = await createSanityDraft(ctx.env, db, {
      user,
      profile: profileOf(ctx),
      runId: ctx.runId,
      draftId: input.draftId,
      article: input.article,
      texts: input.texts,
      sourceUrls: input.sourceUrls,
      provider: input.provider,
      model: input.model,
      existingImageAssetId: input.existingImageAssetId,
    });
    if (input.revised) await setDraftStatus(db, input.draftId, "pending_approval");
    return result;
  },
});
