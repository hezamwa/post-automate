import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { scoreAndSelect } from "../../modules/discovery";
import { candidateRefSchema } from "../../modules/discovery/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 3c (FR-5.2): score every candidate with reasons, keep the best ≥ 6.
// null = nothing qualified → the pipeline records the run as skipped.
export const score = defineStep({
  name: "score",
  input: z.object({ candidates: z.array(candidateRefSchema) }),
  output: candidateRefSchema.nullable(),
  bills: "scoring",
  retries: RETRY.ai,
  run: async (ctx, { candidates }) => {
    const db = createDb(ctx.env);
    const topic = await scoreAndSelect(ctx.env, db, moduleCtx(ctx), candidates);
    if (topic) await setRunState(db, ctx.runId, "drafting");
    return topic;
  },
});
