import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunAngleProposals } from "../../db/commands";
import { candidateRefSchema } from "../../modules/discovery/types";
import { proposeAngles } from "../../modules/generation";
import { angleProposalsSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 5 (FR-6.3): 3 angles + a recommendation, stored on the run so the app can
// render the picker and change-angle (FR-7.9).
export const angles = defineStep({
  name: "angles",
  input: z.object({ topic: candidateRefSchema }),
  output: angleProposalsSchema,
  bills: "angles",
  retries: RETRY.ai,
  run: async (ctx, { topic }) => {
    const db = createDb(ctx.env);
    const proposals = await proposeAngles(ctx.env, db, moduleCtx(ctx), topic);
    await setRunAngleProposals(db, ctx.runId, proposals);
    return proposals;
  },
});
