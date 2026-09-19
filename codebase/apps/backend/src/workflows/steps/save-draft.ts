import { z } from "zod";
import { createDb } from "../../db/client";
import { createDraft } from "../../db/commands";
import { angleSchema, qualityCheckSchema } from "../../modules/generation/types";
import { defineStep, RETRY } from "./step";

// Spec §3 step 9: the drafts row — markdown lives here, the app's editing source of
// truth until publish (DR-9.11).
export const saveDraft = defineStep({
  name: "save-draft",
  input: z.object({ topicId: z.string().uuid(), angle: angleSchema, markdown: z.string(), qualityCheck: qualityCheckSchema.nullable() }),
  output: z.object({ id: z.string().uuid() }),
  retries: RETRY.io,
  run: async (ctx, input) =>
    createDraft(createDb(ctx.env), { runId: ctx.runId, userId: ctx.userId, ...input }),
});
