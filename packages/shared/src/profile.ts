import { z } from "zod";

// Creator Profile — design §4, FR-3.x. Single source of truth: the DB payload,
// the onboarding interview's structured output, and the API schema all derive from this.

export const interestSchema = z.object({
  topic: z.string().min(1),
  weight: z.number().int().min(1).max(5),
});

export const complianceSchema = z.object({
  noDiagnosis: z.literal(true),
  noDosage: z.literal(true),
  noCaseReferences: z.literal(true), // FR-6.8 (OD-6): never real cases/institutions
  disclaimerText: z.string().min(1),
});

export const profileSchema = z
  .object({
    identity: z.object({
      displayName: z.string().min(1),
      sanityAuthorId: z.string().min(1),
    }),
    domain: z.object({
      field: z.enum(["tech", "medical"]),
      subNiches: z.array(z.string().min(1)).min(1),
    }),
    voice: z.object({
      tone: z.array(z.string()),
      formality: z.enum(["casual", "neutral", "formal"]),
      sentenceLength: z.enum(["short", "mixed", "long"]),
      emojiPolicy: z.enum(["never", "sparing", "free"]),
      hashtagPolicy: z.enum(["never", "few", "many"]),
      hookStyle: z.string(),
    }),
    audience: z.object({
      description: z.string().min(1),
      expertiseLevel: z.enum(["general", "informed", "expert"]),
    }),
    topicPolicy: z.object({
      interests: z.array(interestSchema).min(1),
      bannedTopics: z.array(z.string()),
    }),
    cadence: z.object({
      postsPerWeek: z.number().int().min(1).max(7),
      preferredDays: z.array(
        z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
      ),
      preferredHourUtc: z.number().int().min(0).max(23),
    }),
    language: z.enum(["ar", "en", "bilingual"]), // FR-3.7 (OD-3): per-user setting
    format: z
      .object({
        type: z.literal("article"), // FR-6.11 (OD-13)
        targetWords: z.number().int().min(300).max(3000),
      })
      .default({ type: "article", targetWords: 1200 }),
    examplePosts: z.array(z.string().min(1)).min(2), // FR-3.8: few-shot source
    aiDisclosure: z.boolean().default(false), // FR-6.18 (OD-22)
    compliance: complianceSchema.optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.domain.field === "medical" && !profile.compliance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compliance"],
        message: "compliance is required for medical profiles (FR-3.9)",
      });
    }
  });

export type Profile = z.infer<typeof profileSchema>;
export type Compliance = z.infer<typeof complianceSchema>;
