import type { WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { imageConceptsSchema } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { imageConcepts } from "../steps/image-concepts";
import { runStep } from "../steps/step";
import { defineGate, resolveGate } from "./gate";

// The image gate (spec §4.3): 2–3 concepts or "no hero image"; free text is a custom
// concept. The chosen concept (as text, or "none") is stored on the run.

export const NO_IMAGE = "none";

export const imageChoiceSchema = z.union([
  z.object({ optionId: z.string().min(1) }).strict(),
  z.object({ freeText: z.string().trim().min(3).max(500) }).strict(),
]);
export type ImageChoice = z.infer<typeof imageChoiceSchema>;

async function conceptsOf(ctx: RunContext) {
  const run = await createDb(ctx.env).query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, ctx.runId) });
  return imageConceptsSchema.parse(run?.imageConcepts).concepts;
}

export const imageGate = defineGate<ImageChoice>({
  name: "image",
  options: async (ctx) => {
    const concepts = await conceptsOf(ctx);
    return {
      options: [
        ...concepts.map((c) => ({ id: c.id, title: c.title, summary: c.description, why: c.why })),
        { id: NO_IMAGE, title: "No hero image", summary: "Publish the article without an illustration.", why: "" },
      ],
      recommended: concepts[0]!.id,
    };
  },
  choice: imageChoiceSchema,
  recommended: async (ctx) => ({ optionId: (await conceptsOf(ctx))[0]!.id }),
  apply: async (ctx, choice) => {
    let chosen: string;
    if ("freeText" in choice) chosen = choice.freeText;
    else if (choice.optionId === NO_IMAGE) chosen = NO_IMAGE;
    else {
      const concept = (await conceptsOf(ctx)).find((c) => c.id === choice.optionId);
      if (!concept) throw new Error(`unknown image concept '${choice.optionId}'`);
      chosen = concept.description;
    }
    await createDb(ctx.env).update(schema.pipelineRuns).set({ chosenImageConcept: chosen }).where(eq(schema.pipelineRuns.id, ctx.runId));
  },
});

/** Propose concepts, resolve the gate, return the concept text to render — or null for no image. */
export async function chooseImage(step: WorkflowStep, ctx: RunContext, input: { title: string; excerpt: string }, suffix?: string): Promise<string | null> {
  await runStep(step, ctx, imageConcepts, input, suffix);
  await resolveGate(step, ctx, imageGate, suffix);
  const run = await createDb(ctx.env).query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, ctx.runId) });
  const chosen = run?.chosenImageConcept ?? null;
  ctx.choices.image = chosen;
  return chosen === NO_IMAGE ? null : chosen;
}
