import { z } from "zod";
import { createDb } from "../../db/client";
import { deriveTexts } from "../../modules/generation";
import { articleSchema, derivedTextsSchema, textDerivativeOutcomeSchema } from "../../modules/generation/types";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// TEMPORARY (v1 behaviour): X + LinkedIn + translation in one step, before review.
// Replaced by derive-x / derive-linkedin / translate after approval (spec §3 steps 14–16).
export const derivatives = defineStep({
  name: "derivatives",
  input: z.object({ article: articleSchema }),
  output: z.object({ texts: derivedTextsSchema, outcomes: z.array(textDerivativeOutcomeSchema) }),
  bills: "shorten_x",
  retries: RETRY.ai,
  run: async (ctx, { article }) => deriveTexts(ctx.env, createDb(ctx.env), moduleCtx(ctx), article),
});
