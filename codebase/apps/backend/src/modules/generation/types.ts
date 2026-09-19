import { z } from "zod";
import { languageSchema } from "@post-automate/shared";

// Generation domain shapes (AR-10.2): angles, the article, derivative outcomes.

export const angleSchema = z.object({
  headline: z.string(),
  thesis: z.string(),
  whyThisCreator: z.string(),
  outline: z.array(z.string()),
});
export type Angle = z.infer<typeof angleSchema>;

/** The `angles` step output, persisted to pipeline_runs.angle_proposals (FR-6.3, FR-7.9). */
export const angleProposalsSchema = z.object({
  angles: z.array(angleSchema).min(1),
  recommendedIndex: z.number().int().min(0),
});
export type AngleProposals = z.infer<typeof angleProposalsSchema>;

/** The article plus the per-site mapper inputs, in one structured call (FR-6.5, FR-8.2). */
export const articleSchema = z.object({
  title: z.string(),
  slug: z.string(),
  excerpt: z.string(),
  tags: z.array(z.string()),
  imageAlt: z.string(),
  markdown: z.string(),
});
export type Article = z.infer<typeof articleSchema>;

/** Article + provenance for generationMeta (FR-8.2). */
export const articleResultSchema = z.object({
  article: articleSchema,
  provider: z.string(),
  model: z.string(),
});
export type ArticleResult = z.infer<typeof articleResultSchema>;

export const translationMetaSchema = z.object({
  title: z.string(),
  excerpt: z.string(),
  imageAlt: z.string(),
  targetLanguage: languageSchema,
});

/** One per-kind outcome row for DR-9.14 — recorded to draft_derivatives by the caller. */
export const textDerivativeOutcomeSchema = z.object({
  kind: z.enum(["x", "linkedin", "translation"]),
  outcome: z.enum(["produced", "skipped", "failed"]),
  content: z.string().optional(),
  reason: z.string().optional(), // why skipped/failed — human-readable, surfaced on the review screen
  meta: translationMetaSchema.optional(), // translation only (design §8)
});
export type TextDerivativeOutcome = z.infer<typeof textDerivativeOutcomeSchema>;

export const derivedTextsSchema = z.object({
  xVersion: z.string().optional(),
  linkedinVersion: z.string().optional(),
  translatedMarkdown: z.string().optional(),
});
export type DerivedTexts = z.infer<typeof derivedTextsSchema>;

export const heroOutcomeSchema = z.object({
  outcome: z.enum(["produced", "skipped", "failed"]),
  assetRef: z.string().optional(),
  reason: z.string().optional(),
});
export type HeroOutcome = z.infer<typeof heroOutcomeSchema>;
