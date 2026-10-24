import type { WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { angleProposalsSchema, type Angle, type AngleProposals } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { defineGate, resolveGate } from "./gate";

// The angle gate (spec §4.3): the 3 stored proposals + the recommendation. Free text
// becomes a fourth angle, appended to the run's proposals so change_angle can find it.

export const angleChoiceSchema = z.union([
  z.object({ optionId: z.string().regex(/^\d+$/) }).strict(),
  z.object({ freeText: z.string().trim().min(3).max(300) }).strict(),
]);
export type AngleChoice = z.infer<typeof angleChoiceSchema>;

async function proposalsOf(ctx: RunContext): Promise<AngleProposals> {
  const run = await createDb(ctx.env).query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, ctx.runId) });
  return angleProposalsSchema.parse(run?.angleProposals);
}

export const angleGate = defineGate<AngleChoice>({
  name: "angle",
  options: async (ctx) => {
    const { angles, recommendedIndex } = await proposalsOf(ctx);
    return {
      options: angles.map((a, i) => ({ id: String(i), title: a.headline, summary: a.thesis, why: a.whyThisCreator })),
      recommended: String(recommendedIndex),
    };
  },
  choice: angleChoiceSchema,
  recommended: async (ctx) => ({ optionId: String((await proposalsOf(ctx)).recommendedIndex) }),
  apply: async (ctx, choice) => {
    const db = createDb(ctx.env);
    const proposals = await proposalsOf(ctx);
    let index: number;
    if ("optionId" in choice) {
      index = Math.min(Math.max(Number(choice.optionId), 0), proposals.angles.length - 1);
    } else {
      const own: Angle = { headline: choice.freeText, thesis: choice.freeText, whyThisCreator: "The creator's own angle.", outline: [] };
      index = proposals.angles.length;
      await db.update(schema.pipelineRuns).set({ angleProposals: { ...proposals, angles: [...proposals.angles, own] } }).where(eq(schema.pipelineRuns.id, ctx.runId));
    }
    await db.update(schema.pipelineRuns).set({ chosenAngleIndex: index }).where(eq(schema.pipelineRuns.id, ctx.runId));
  },
});

/** Resolve the gate and return the angle the run continues with (and its index). */
export async function chooseAngle(step: WorkflowStep, ctx: RunContext, _proposals: AngleProposals): Promise<{ angle: Angle; index: number; proposals: AngleProposals }> {
  await resolveGate(step, ctx, angleGate);
  const proposals = await proposalsOf(ctx);
  const run = await createDb(ctx.env).query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, ctx.runId) });
  const index = run?.chosenAngleIndex ?? proposals.recommendedIndex;
  ctx.choices.angle = index;
  return { angle: proposals.angles[index]!, index, proposals };
}
