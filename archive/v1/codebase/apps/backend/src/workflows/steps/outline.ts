import { z } from "zod";
import { createDb } from "../../db/client";
import { setRunOutline } from "../../db/commands";
import { sourcesForRun } from "../../db/queries";
import { candidateRefSchema } from "../../modules/discovery/types";
import { writeOutline } from "../../modules/generation";
import { angleSchema, outlineSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

export const EXCERPT_CHARS = 3000;

/** Source excerpts as the prompts take them — the first few thousand chars of each page. */
export async function sourceExcerpts(ctx: { env: import("../../shared/env").Env; runId: string }): Promise<Array<{ url: string; excerpt: string }>> {
  return (await sourcesForRun(createDb(ctx.env), ctx.runId)).map((s) => ({ url: s.url, excerpt: s.content.slice(0, EXCERPT_CHARS) }));
}

// Spec §3 step 6: the outline for the chosen angle, one call, stored on the run so the
// gate can show it and the draft can follow it. `instructions` = the creator asked for
// another one at the outline gate.
export const outline = defineStep({
  name: "outline",
  input: z.object({ topic: candidateRefSchema, angle: angleSchema, instructions: z.string().optional() }),
  output: outlineSchema,
  bills: "outline",
  retries: RETRY.ai,
  run: async (ctx, input) => {
    const db = createDb(ctx.env);
    const result = await writeOutline(ctx.env, db, moduleCtx(ctx), { ...input, sources: await sourceExcerpts(ctx) });
    await setRunOutline(db, ctx.runId, result);
    return result;
  },
});
