import type { WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "../../db/client";
import { scoredCandidates } from "../../db/queries";
import { candidateFromRow, selectCandidate } from "../../modules/discovery";
import type { CandidateRef } from "../../modules/discovery/types";
import type { RunContext } from "../context";
import { research } from "../steps/research";
import { search } from "../steps/search";
import { runStep } from "../steps/step";
import { defineGate, resolveGate } from "./gate";

// The topic gate (spec §4.3): the scored candidates, best first, with score and reason.
// Free text routes the run through `research` as a user-topic run.

export const topicChoiceSchema = z.union([
  z.object({ optionId: z.string().uuid() }).strict(),
  z.object({ freeText: z.string().trim().min(3).max(300) }).strict(),
]);
export type TopicChoice = z.infer<typeof topicChoiceSchema>;

export const topicGate = defineGate<TopicChoice>({
  name: "topic",
  options: async (ctx) => {
    const rows = await scoredCandidates(createDb(ctx.env), ctx.runId);
    return {
      options: rows.map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        why: `score ${r.score ?? "–"}/10 — ${r.rejectionReason ?? "recommended"}${r.whyItMatters ? ` · ${r.whyItMatters}` : ""}`,
      })),
      recommended: rows.find((r) => r.selected)?.id ?? rows[0]?.id ?? "",
    };
  },
  choice: topicChoiceSchema,
  recommended: async (ctx) => {
    const best = (await scoredCandidates(createDb(ctx.env), ctx.runId)).find((r) => r.selected);
    if (!best) throw new Error("no candidate scored ≥ 6 — the pipeline should have skipped before the topic gate (FR-5.2)");
    return { optionId: best.id };
  },
  apply: async (ctx, choice) => {
    const db = createDb(ctx.env);
    if ("optionId" in choice) {
      await selectCandidate(db, ctx.runId, choice.optionId);
      await db.update(schema.pipelineRuns).set({ chosenTopicId: choice.optionId }).where(eq(schema.pipelineRuns.id, ctx.runId));
    } else {
      // the creator's own topic: the run continues as a user-topic run (spec §4.3)
      await db.update(schema.pipelineRuns).set({ userTopic: { title: choice.freeText } }).where(eq(schema.pipelineRuns.id, ctx.runId));
    }
  },
});

/** Resolve the gate and return the topic the run continues with. */
export async function chooseTopic(step: WorkflowStep, ctx: RunContext): Promise<CandidateRef> {
  const choice = await resolveGate(step, ctx, topicGate);
  const db = createDb(ctx.env);
  if ("optionId" in choice) {
    const row = await db.query.topicCandidates.findFirst({ where: eq(schema.topicCandidates.id, choice.optionId) });
    if (!row) throw new Error(`chosen candidate ${choice.optionId} not found`);
    return candidateFromRow(row);
  }
  const userTopic = { title: choice.freeText };
  const { results: fetched } = await runStep(step, ctx, search, { query: userTopic.title }, "topic");
  return runStep(step, ctx, research, { userTopic, fetched }, "topic");
}
