import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { findTopics } from "../../modules/discovery";
import { candidateRefSchema } from "../../modules/discovery/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// TEMPORARY (v1 behaviour): discovery = search + synthesis in one call. Replaced by the
// `search` and `synthesize-candidates` steps in the splits phase (spec §3 steps 3a/3b).
export const discover = defineStep({
  name: "discover",
  input: z.object({}),
  output: z.array(candidateRefSchema),
  bills: "discovery",
  retries: RETRY.ai,
  run: async (ctx) => {
    const db = createDb(ctx.env);
    const candidates = await findTopics(ctx.env, db, moduleCtx(ctx));
    await setRunState(db, ctx.runId, "scoring");
    return candidates;
  },
});
