import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { synthesizeCandidates as synthesize } from "../../modules/discovery";
import { candidateRefSchema, fetchedResultSchema } from "../../modules/discovery/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 3b (FR-5.4): snippets → 8–10 candidate topics, all persisted (DR-9.3).
export const synthesizeCandidates = defineStep({
  name: "synthesize-candidates",
  input: z.object({ fetched: z.array(fetchedResultSchema).nullable() }),
  output: z.array(candidateRefSchema),
  bills: "discovery",
  retries: RETRY.ai,
  run: async (ctx, { fetched }) => {
    const db = createDb(ctx.env);
    const candidates = await synthesize(ctx.env, db, moduleCtx(ctx), fetched);
    await setRunState(db, ctx.runId, "scoring");
    return candidates;
  },
});
