import { z } from "zod";
import { GateError } from "../../ai/gates";
import { NoRouteError } from "../../ai/router";
import { createDb } from "../../db/client";
import { getUserById, recordDerivatives } from "../../db/commands";
import { generateHeroImage } from "../../modules/generation";
import { heroOutcomeSchema } from "../../modules/generation/types";
import { uploadHeroImage } from "../../modules/publishing";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 11 (FR-6.13): one image call, uploaded to Sanity assets; only the asset
// reference leaves the step. A revision keeps the existing image (FR-7.9). Skip-not-fail:
// no route = skipped, a failed generation or upload = failed — the reviewer sees why.
export const heroImage = defineStep({
  name: "hero-image",
  input: z.object({
    draftId: z.string().uuid(),
    revisionNo: z.number().int().min(0),
    article: z.object({ title: z.string(), slug: z.string() }),
    existingAssetRef: z.string().optional(),
  }),
  output: heroOutcomeSchema,
  bills: "image",
  retries: RETRY.ai,
  run: async (ctx, { draftId, revisionNo, article, existingAssetRef }) => {
    const db = createDb(ctx.env);
    let outcome: z.infer<typeof heroOutcomeSchema>;
    if (existingAssetRef) {
      outcome = { outcome: "produced", assetRef: existingAssetRef };
    } else {
      try {
        const image = await generateHeroImage(ctx.env, db, moduleCtx(ctx), article.title);
        const assetRef = await uploadHeroImage(ctx.env, await getUserById(db, ctx.userId), image, article.slug);
        outcome = { outcome: "produced", assetRef };
      } catch (e) {
        if (e instanceof GateError) throw e; // ai.paused/caps halt the step (FR-15.12a), not degrade
        outcome =
          e instanceof NoRouteError
            ? { outcome: "skipped", reason: "The 'image' capability is disabled — no enabled route (FR-15.13). Re-enable a route and revise the draft to generate it." }
            : { outcome: "failed", reason: e instanceof Error ? e.message.slice(0, 300) : "unknown error" };
        console.warn("hero image generation/upload failed — draft continues without image:", outcome.reason);
      }
    }
    await recordDerivatives(db, draftId, revisionNo, [{ kind: "hero_image", ...outcome }]);
    return outcome;
  },
});
