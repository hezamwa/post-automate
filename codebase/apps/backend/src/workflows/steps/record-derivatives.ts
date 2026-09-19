import { z } from "zod";
import { createDb } from "../../db/client";
import { recordDerivatives } from "../../db/commands";
import { defineStep, RETRY } from "./step";

// TEMPORARY (v1 behaviour): one row per derivative per revision (DR-9.14), written after
// the bundled derivatives step. Each per-kind step persists its own row after the split.
export const derivativeRecordSchema = z.object({
  kind: z.enum(["hero_image", "x", "linkedin", "translation"]),
  outcome: z.enum(["produced", "skipped", "failed"]),
  content: z.string().optional(),
  assetRef: z.string().optional(),
  reason: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

export const recordDerivativesStep = defineStep({
  name: "record-derivatives",
  input: z.object({ draftId: z.string().uuid(), revisionNo: z.number().int().min(0), records: z.array(derivativeRecordSchema) }),
  output: z.object({ recorded: z.number().int() }),
  retries: RETRY.io,
  run: async (ctx, { draftId, revisionNo, records }) => {
    await recordDerivatives(createDb(ctx.env), draftId, revisionNo, records);
    return { recorded: records.length };
  },
});
