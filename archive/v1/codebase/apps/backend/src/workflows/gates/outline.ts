import type { WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { setRunOutline } from "../../db/commands";
import type { CandidateRef } from "../../modules/discovery/types";
import { outlineSchema, type Angle, type Outline } from "../../modules/generation/types";
import type { RunContext } from "../context";
import { outline as outlineStep } from "../steps/outline";
import { runStep } from "../steps/step";
import { defineGate, resolveGate } from "./gate";

// The outline gate (spec §4.3): one outline — approve it, edit its sections, or ask for
// another (free text → regenerated). The approved outline is what the draft follows.

export const MAX_REGENERATIONS = 2;

export const outlineChoiceSchema = z.union([
  z.object({ optionId: z.literal("approve") }).strict(),
  z.object({ sections: outlineSchema.shape.sections }).strict(),
  z.object({ freeText: z.string().trim().min(3).max(500) }).strict(),
]);
export type OutlineChoice = z.infer<typeof outlineChoiceSchema>;

async function outlineOf(ctx: RunContext): Promise<Outline> {
  const run = await createDb(ctx.env).query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, ctx.runId) });
  return outlineSchema.parse(run?.outline);
}

export const renderOutline = (o: Outline) => o.sections.map((s, i) => `${i + 1}. ${s.heading}${s.keyPoints.length ? ` — ${s.keyPoints.join("; ")}` : ""}`).join("\n");

export const outlineGate = defineGate<OutlineChoice>({
  name: "outline",
  options: async (ctx) => {
    const current = await outlineOf(ctx);
    return {
      options: [{ id: "approve", title: `${current.sections.length} sections`, summary: renderOutline(current), why: "Edit any section, or ask for a different outline in your own words." }],
      recommended: "approve",
    };
  },
  choice: outlineChoiceSchema,
  recommended: async () => ({ optionId: "approve" }),
  apply: async (ctx, choice) => {
    if ("sections" in choice) await setRunOutline(createDb(ctx.env), ctx.runId, { sections: choice.sections });
  },
});

/** Generate the outline, resolve the gate (regenerating on free text, bounded), return the approved outline. */
export async function chooseOutline(step: WorkflowStep, ctx: RunContext, input: { topic: CandidateRef; angle: Angle }, suffix?: string): Promise<Outline> {
  const tag = (s?: string) => [suffix, s].filter(Boolean).join("-") || undefined;
  await runStep(step, ctx, outlineStep, input, tag());
  for (let attempt = 0; ; attempt++) {
    const choice = await resolveGate(step, ctx, outlineGate, tag(attempt ? `regen${attempt}` : undefined));
    // A bounded number of "another one, please": past the cap the latest outline stands —
    // a cost guard, not a timeout (the gate still never auto-proceeds on silence).
    if (!("freeText" in choice) || attempt >= MAX_REGENERATIONS) break;
    await runStep(step, ctx, outlineStep, { ...input, instructions: choice.freeText }, tag(`regen${attempt + 1}`));
  }
  const approved = await outlineOf(ctx);
  ctx.choices.outline = approved;
  return approved;
}
