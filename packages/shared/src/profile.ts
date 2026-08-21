import { z } from "zod";

// Creator Profile — design §4, FR-3.x. Single source of truth: the DB payload,
// the onboarding interview's structured output, and the API schema all derive from this.

/**
 * The shape version of `profiles.payload`, stored in `profiles.schema_version` (DR-9.15).
 * Distinct from `profiles.version` (the user's edit history). v2 (2026-08-21, OD-3 revised):
 * the `language` enum split into `primaryLanguage` + opt-in `translation` (FR-3.7, FR-3.13).
 */
export const PROFILE_SCHEMA_VERSION = 2;

export const languageSchema = z.enum(["ar", "en"]);

export const interestSchema = z
  .object({
    topic: z.string().min(1),
    weight: z.number().int().min(1).max(5),
  })
  .strict();

export const complianceSchema = z
  .object({
    noDiagnosis: z.literal(true),
    noDosage: z.literal(true),
    noCaseReferences: z.literal(true), // FR-6.8 (OD-6): never real cases/institutions
    disclaimerText: z.string().min(1),
  })
  .strict();

// FR-3.13: translation is opt-in and independent of primaryLanguage. targetLanguage is
// required when enabled — enforced at the profile level, where primaryLanguage is in scope.
export const translationSchema = z
  .object({
    enabled: z.boolean(),
    targetLanguage: languageSchema.optional(),
  })
  .strict();

// Fields common to every payload shape version. profileSchemaV1 and profileSchema extend
// this — a change to a common field is NOT free: it alters the historic shape too, and
// historic shapes must stay readable (DR-9.15). Split the field out per version instead.
const commonFields = {
  // Author reference dropped 2026-07-16 — both sites are single-author; the Sanity
  // project binding lives on the user record (FR-8.5)
  identity: z
    .object({
      displayName: z.string().min(1),
    })
    .strict(),
  domain: z
    .object({
      field: z.enum(["tech", "medical"]),
      subNiches: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  voice: z
    .object({
      tone: z.array(z.string()),
      formality: z.enum(["casual", "neutral", "formal"]),
      sentenceLength: z.enum(["short", "mixed", "long"]),
      emojiPolicy: z.enum(["never", "sparing", "free"]),
      hashtagPolicy: z.enum(["never", "few", "many"]),
      hookStyle: z.string(),
    })
    .strict(),
  audience: z
    .object({
      description: z.string().min(1),
      expertiseLevel: z.enum(["general", "informed", "expert"]),
    })
    .strict(),
  topicPolicy: z
    .object({
      interests: z.array(interestSchema).min(1),
      bannedTopics: z.array(z.string()),
    })
    .strict(),
  cadence: z
    .object({
      postsPerWeek: z.number().int().min(1).max(7),
      preferredDays: z.array(
        z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
      ),
      preferredHourUtc: z.number().int().min(0).max(23),
    })
    .strict(),
  format: z
    .object({
      type: z.literal("article"), // FR-6.11 (OD-13)
      targetWords: z.number().int().min(300).max(3000),
    })
    .strict()
    .default({ type: "article", targetWords: 1200 }),
  examplePosts: z.array(z.string().min(1)).min(2), // FR-3.8: few-shot source
  aiDisclosure: z.boolean().default(false), // FR-6.18 (OD-22)
  // FR-3.12: which social derivatives to generate per article (FR-6.12)
  channels: z.array(z.enum(["x", "linkedin"])).default(["x", "linkedin"]),
  compliance: complianceSchema.optional(),
};

function requireMedicalCompliance(
  profile: { domain: { field: "tech" | "medical" }; compliance?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (profile.domain.field === "medical" && !profile.compliance) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["compliance"],
      message: "compliance is required for medical profiles (FR-3.9)",
    });
  }
}

export const profileSchema = z
  .object({
    ...commonFields,
    // FR-3.7 (OD-3 revised): the single language every article is generated in.
    // Required with no default — it may never be left implicit (requirements §13 Phase 1).
    primaryLanguage: languageSchema,
    // FR-3.13: opt-in, independent of primaryLanguage; required so "off" is stated, not implied.
    translation: translationSchema,
  })
  // design §4 specifies "additionalProperties": false throughout. Strict, not stripping:
  // an invented field — especially from the interview's structured output (FR-4.2) —
  // must surface as an error rather than vanish silently.
  .strict()
  .superRefine((profile, ctx) => {
    requireMedicalCompliance(profile, ctx);
    const { enabled, targetLanguage } = profile.translation;
    if (enabled && !targetLanguage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["translation", "targetLanguage"],
        message: "targetLanguage is required when translation is enabled (FR-3.13)",
      });
    }
    // Checked even while translation is disabled: a stale target equal to primaryLanguage
    // would become a same-language "translation" the moment someone flips the flag.
    if (targetLanguage && targetLanguage === profile.primaryLanguage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["translation", "targetLanguage"],
        message: "targetLanguage must differ from primaryLanguage (FR-3.13)",
      });
    }
  });

/**
 * Historic payload shape v1 (superseded 2026-08-21): a single `language` enum where
 * "bilingual" conflated the generation language with the translation preference.
 * Kept for migration tests and future upcasts only (design §4 "Schema evolution") —
 * task code must never import it.
 */
export const profileSchemaV1 = z
  .object({
    ...commonFields,
    language: z.enum(["ar", "en", "bilingual"]),
  })
  .strict()
  .superRefine(requireMedicalCompliance);

export type Profile = z.infer<typeof profileSchema>;
export type ProfileV1 = z.infer<typeof profileSchemaV1>;
export type Compliance = z.infer<typeof complianceSchema>;
export type Language = z.infer<typeof languageSchema>;
