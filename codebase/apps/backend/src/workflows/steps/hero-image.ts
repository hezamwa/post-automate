import { z } from "zod";
import { GateError } from "../../ai/gates";
import { NoRouteError } from "../../ai/router";
import { createDb } from "../../db/client";
import { getUserById, recordDerivatives } from "../../db/commands";
import { generateHeroImage } from "../../modules/generation";
import { DECLINED_REASON } from "../../modules/generation/channels";
import { uploadHeroImage } from "../../modules/publishing";
import { moduleCtx } from "../context";
import { defineStep, RETRY } from "./step";

// Spec §3 step 11 (FR-6.13): the CHOSEN concept generated with one image call, uploaded
// to Sanity assets; only the asset reference leaves the step. "No hero image" at the
// image gate → declined (a row, no call). A revision keeps the existing image (FR-7.9).
// Skip-not-fail: no route = skipped, a failed generation or upload = failed.

const outcomeSchema = z.object({
  outcome: z.enum(["produced", "skipped", "failed", "declined"]),
  assetRef: z.string().optional(),
  reason: z.string().optional(),
});

export const heroImage = defineStep({
  name: "hero-image",
  input: z.object({
    draftId: z.string().uuid(),
    revisionNo: z.number().int().min(0),
    article: z.object({ title: z.string(), slug: z.string() }),
    /** The chosen concept text; null = the creator wants no hero image. */
    concept: z.string().nullable(),
    existingAssetRef: z.string().optional(),
  }),
  output: outcomeSchema,
  bills: "image",
  retries: RETRY.ai,
  run: async (ctx, { draftId, revisionNo, article, concept, existingAssetRef }) => {
    const db = createDb(ctx.env);
    let outcome: z.infer<typeof outcomeSchema>;
    if (existingAssetRef) {
      outcome = { outcome: "produced", assetRef: existingAssetRef };
    } else if (concept === null) {
      outcome = { outcome: "declined", reason: DECLINED_REASON };
    } else {
      try {
        const image = await generateHeroImage(ctx.env, db, moduleCtx(ctx), { headline: article.title, concept });
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
