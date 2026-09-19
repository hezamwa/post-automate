import { z } from "zod";
import { createDb } from "../../db/client";
import { addDraftRevision, setDraftStatus } from "../../db/commands";
import { candidateRefSchema } from "../../modules/discovery/types";
import { ComplianceRefusalError, writeArticle } from "../../modules/generation";
import { angleSchema, articleResultSchema, outlineSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { sourceExcerpts } from "./outline";
import { defineStep, RETRY } from "./step";

// Spec §3 step 7 (FR-6.3 step 2): the article. CANNOT_COMPLY is a decision, not a
// failure — non-retryable. A revision carries instructions (revise, FR-7.9) or only a new
// angle (change_angle); either way the draft shows as `revising` while it is written.

export const draftRevisionSchema = z.object({
  /** Absent for the automatic quality-check revise, which happens before a draft row exists. */
  draftId: z.string().uuid().optional(),
  revisionNo: z.number().int().positive().optional(),
  /** Present for revise; absent for change_angle. */
  instructions: z.string().optional(),
  currentMarkdown: z.string().optional(),
});

export const draft = defineStep({
  name: "draft",
  input: z.object({
    topic: candidateRefSchema,
    angle: angleSchema,
    /** The approved outline (spec §3 step 6); the fetched sources are read from the run. */
    outline: outlineSchema.nullable(),
    revision: draftRevisionSchema.optional(),
  }),
  output: articleResultSchema,
  bills: "article",
  retries: RETRY.ai,
  nonRetryable: [ComplianceRefusalError],
  run: async (ctx, { topic, angle, outline, revision }) => {
    const db = createDb(ctx.env);
    if (revision?.draftId) await setDraftStatus(db, revision.draftId, "revising");
    const rewrite =
      revision?.instructions != null && revision.currentMarkdown != null
        ? { currentMarkdown: revision.currentMarkdown, instructions: revision.instructions }
        : undefined;
    const result = await writeArticle(ctx.env, db, moduleCtx(ctx), topic, angle, rewrite, { outline, sources: await sourceExcerpts(ctx) });
    // The instructions row feeds profile refinement (DR-9.12) — written after the call so a
    // retried step never records the same revision twice.
    if (revision?.draftId && revision.revisionNo && revision.instructions != null) {
      await addDraftRevision(db, { draftId: revision.draftId, revisionNo: revision.revisionNo, instructions: revision.instructions });
    }
    return result;
  },
});
