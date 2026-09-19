import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { researchTopic } from "../../modules/discovery";
import { candidateRefSchema } from "../../modules/discovery/types";
import { moduleCtx, userTopicSchema } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 3d (FR-5.8): user-topic runs only — targeted research replaces 3a–3c.
export const research = defineStep({
  name: "research",
  input: z.object({ userTopic: userTopicSchema }),
  output: candidateRefSchema,
  bills: "research",
  retries: RETRY.ai,
  run: async (ctx, { userTopic }) => {
    const db = createDb(ctx.env);
    const topic = await researchTopic(ctx.env, db, moduleCtx(ctx), userTopic);
    await setRunState(db, ctx.runId, "drafting");
    return topic;
  },
});
