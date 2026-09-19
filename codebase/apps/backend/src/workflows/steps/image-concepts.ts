import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { proposeImageConcepts } from "../../modules/generation";
import { imageConceptsSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 10: 2–3 hero-image concepts as short text, stored on the run for the image
// gate. The image is NOT generated here — only the chosen concept is, in hero-image.
export const imageConcepts = defineStep({
  name: "image-concepts",
  input: z.object({ title: z.string(), excerpt: z.string() }),
  output: imageConceptsSchema,
  bills: "image_concepts",
  retries: RETRY.ai,
  run: async (ctx, input) => {
    const db = createDb(ctx.env);
    const concepts = await proposeImageConcepts(ctx.env, db, moduleCtx(ctx), input);
    await db.update(schema.pipelineRuns).set({ imageConcepts: { concepts } }).where(eq(schema.pipelineRuns.id, ctx.runId));
    return { concepts };
  },
});
