import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunState } from "../../db/commands";
import { researchTopic } from "../../modules/discovery";
import { candidateRefSchema, fetchedResultSchema } from "../../modules/discovery/types";
import { moduleCtx, userTopicSchema } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 3d (FR-5.8): user-topic runs only — one call turning the search snippets and
// the creator's links into a brief with cited sources; replaces 3b–3c and the topic gate.
export const research = defineStep({
  name: "research",
  input: z.object({ userTopic: userTopicSchema, fetched: z.array(fetchedResultSchema).nullable() }),
  output: candidateRefSchema,
  bills: "research",
  retries: RETRY.ai,
  run: async (ctx, { userTopic, fetched }) => {
    const db = createDb(ctx.env);
    const topic = await researchTopic(ctx.env, db, moduleCtx(ctx), userTopic, fetched);
    await setRunState(db, ctx.runId, "drafting");
    return topic;
  },
});
