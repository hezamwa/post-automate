import { z } from "zod";
import { createDb } from "../../db/client";
import { getUserById, setDraftStatus, updateDraftMarkdown } from "../../db/commands";
import { articleSchema } from "../../modules/generation/types";
import { writeSanityDraft as writeDoc } from "../../modules/publishing";
import { profileOf } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 12 (FR-8.1..8.3): markdown → Portable Text, per-site mapper, written as
// drafts.postauto-{runId} with the asset reference — deterministic id, so a retry cannot
// duplicate. A revision also refreshes the drafts row and returns it to pending_approval.
export const writeSanityDraft = defineStep({
  name: "write-sanity-draft",
  input: z.object({
    draftId: z.string().uuid(),
    revisionNo: z.number().int().min(0),
    article: articleSchema,
    sourceUrls: z.array(z.string()),
    provider: z.string(),
    model: z.string(),
    imageAssetId: z.string().optional(),
    revised: z.boolean(),
  }),
  output: z.object({ sanityDocId: z.string() }),
  retries: RETRY.io,
  run: async (ctx, input) => {
    const db = createDb(ctx.env);
    if (input.revised) await updateDraftMarkdown(db, input.draftId, input.article.markdown);
    const result = await writeDoc(ctx.env, db, {
      user: await getUserById(db, ctx.userId),
      profile: profileOf(ctx),
      runId: ctx.runId,
      draftId: input.draftId,
      article: input.article,
      texts: {}, // channel versions are patched on after approval (derive-x / derive-linkedin)
      sourceUrls: input.sourceUrls,
      provider: input.provider,
      model: input.model,
      imageAssetId: input.imageAssetId,
    });
    if (input.revised) await setDraftStatus(db, input.draftId, "pending_approval");
    return result;
  },
});
