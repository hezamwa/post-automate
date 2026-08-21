import { describe, expect, it } from "vitest";
import { profileSchema, profileSchemaV1 } from "./profile";

// FR-3.x. This schema is the single source of truth for the DB payload, the onboarding
// interview's structured output, and the API schema — a gap here propagates everywhere.
const base = {
  identity: { displayName: "Test Creator" },
  domain: { field: "tech", subNiches: ["ai tooling"] },
  voice: {
    tone: ["direct"],
    formality: "neutral",
    sentenceLength: "mixed",
    emojiPolicy: "never",
    hashtagPolicy: "few",
    hookStyle: "question",
  },
  audience: { description: "working developers", expertiseLevel: "informed" },
  topicPolicy: { interests: [{ topic: "ai tooling", weight: 5 }], bannedTopics: [] },
  cadence: { postsPerWeek: 2, preferredDays: ["mon", "thu"], preferredHourUtc: 9 },
  primaryLanguage: "en",
  translation: { enabled: false },
  examplePosts: ["example one", "example two"],
};

describe("profileSchema (FR-3.x)", () => {
  it("accepts a minimal valid tech profile", () => {
    expect(profileSchema.safeParse(base).success).toBe(true);
  });

  it("applies documented defaults for format, disclosure and channels", () => {
    const p = profileSchema.parse(base);
    expect(p.format).toEqual({ type: "article", targetWords: 1200 }); // OD-13
    expect(p.aiDisclosure).toBe(false); // FR-6.18 (OD-22): default OFF
    expect(p.channels).toEqual(["x", "linkedin"]); // FR-3.12
  });

  it("requires compliance on a medical profile (FR-3.9)", () => {
    const medical = { ...base, domain: { field: "medical", subNiches: ["cardiology"] } };
    const result = profileSchema.safeParse(medical);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.join(".") === "compliance")).toBe(true);
  });

  it("accepts a medical profile that carries compliance constraints", () => {
    const medical = {
      ...base,
      domain: { field: "medical", subNiches: ["cardiology"] },
      compliance: {
        noDiagnosis: true,
        noDosage: true,
        noCaseReferences: true, // FR-6.8 (OD-6)
        disclaimerText: "Educational only — not medical advice.",
      },
    };
    expect(profileSchema.safeParse(medical).success).toBe(true);
  });

  it("rejects a compliance block that opts out of a hard constraint", () => {
    const medical = {
      ...base,
      domain: { field: "medical", subNiches: ["cardiology"] },
      compliance: {
        noDiagnosis: true,
        noDosage: false, // must be literal true — these are not negotiable (FR-6.6)
        noCaseReferences: true,
        disclaimerText: "…",
      },
    };
    expect(profileSchema.safeParse(medical).success).toBe(false);
  });

  it("requires at least two example posts for few-shot voice matching (FR-3.8)", () => {
    expect(profileSchema.safeParse({ ...base, examplePosts: ["only one"] }).success).toBe(false);
  });

  it("requires at least one weighted interest (FR-3.5)", () => {
    const noInterests = { ...base, topicPolicy: { interests: [], bannedTopics: [] } };
    expect(profileSchema.safeParse(noInterests).success).toBe(false);
  });

  it("bounds cadence to a real week and a real hour (FR-3.6)", () => {
    const bad = (cadence: unknown) => profileSchema.safeParse({ ...base, cadence }).success;
    expect(bad({ postsPerWeek: 8, preferredDays: ["mon"], preferredHourUtc: 9 })).toBe(false);
    expect(bad({ postsPerWeek: 0, preferredDays: ["mon"], preferredHourUtc: 9 })).toBe(false);
    expect(bad({ postsPerWeek: 2, preferredDays: ["mon"], preferredHourUtc: 24 })).toBe(false);
    expect(bad({ postsPerWeek: 2, preferredDays: ["someday"], preferredHourUtc: 9 })).toBe(false);
  });

  it("bounds interest weights to 1–5 (FR-3.5)", () => {
    const withWeight = (weight: number) =>
      profileSchema.safeParse({
        ...base,
        topicPolicy: { interests: [{ topic: "x", weight }], bannedTopics: [] },
      }).success;
    expect(withWeight(0)).toBe(false);
    expect(withWeight(6)).toBe(false);
    expect(withWeight(3)).toBe(true);
  });

  it("rejects unknown fields rather than silently dropping them", () => {
    // design §4 specifies "additionalProperties": false. Strict, not stripping — an
    // invented field from the interview's structured output (FR-4.2) must be an error.
    expect(profileSchema.safeParse({ ...base, favouriteColour: "blue" }).success).toBe(false);
  });

  it("rejects unknown fields inside nested objects too", () => {
    const bad = { ...base, voice: { ...base.voice, secretSauce: "x" } };
    expect(profileSchema.safeParse(bad).success).toBe(false);
  });

  it("bounds article length to the documented range (OD-13)", () => {
    const withWords = (targetWords: number) =>
      profileSchema.safeParse({ ...base, format: { type: "article", targetWords } }).success;
    expect(withWords(299)).toBe(false);
    expect(withWords(3001)).toBe(false);
    expect(withWords(1200)).toBe(true);
  });
});

describe("primaryLanguage + translation (FR-3.7, FR-3.13 — OD-3 revised)", () => {
  it("requires primaryLanguage — it may never be left implicit", () => {
    const { primaryLanguage: _, ...withoutLanguage } = base;
    expect(profileSchema.safeParse(withoutLanguage).success).toBe(false);
  });

  it("requires translation — 'off' is stated, not implied", () => {
    const { translation: _, ...withoutTranslation } = base;
    expect(profileSchema.safeParse(withoutTranslation).success).toBe(false);
  });

  it("rejects the superseded v1 'language' field (strict shape)", () => {
    expect(profileSchema.safeParse({ ...base, language: "en" }).success).toBe(false);
  });

  it("rejects 'bilingual' as a primaryLanguage — the value the revision removed", () => {
    expect(profileSchema.safeParse({ ...base, primaryLanguage: "bilingual" }).success).toBe(false);
  });

  it("accepts translation enabled with a target differing from primaryLanguage", () => {
    const p = { ...base, translation: { enabled: true, targetLanguage: "ar" } };
    expect(profileSchema.safeParse(p).success).toBe(true);
  });

  it("requires targetLanguage when translation is enabled", () => {
    const result = profileSchema.safeParse({ ...base, translation: { enabled: true } });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((i) => i.path.join(".") === "translation.targetLanguage"),
    ).toBe(true);
  });

  it("rejects targetLanguage equal to primaryLanguage", () => {
    const p = { ...base, translation: { enabled: true, targetLanguage: "en" } };
    expect(profileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a matching targetLanguage even while translation is disabled", () => {
    // A stale target equal to primaryLanguage would become a same-language
    // "translation" the moment someone flips the flag — caught at write time instead.
    const p = { ...base, translation: { enabled: false, targetLanguage: "en" } };
    expect(profileSchema.safeParse(p).success).toBe(false);
  });

  it("accepts a disabled translation that keeps a valid target as a preserved preference", () => {
    const p = { ...base, translation: { enabled: false, targetLanguage: "ar" } };
    expect(profileSchema.safeParse(p).success).toBe(true);
  });
});

describe("profileSchemaV1 (historic shape — DR-9.15)", () => {
  it("still parses a v1 payload, including the removed 'bilingual' value", () => {
    const { primaryLanguage: _p, translation: _t, ...common } = base;
    expect(profileSchemaV1.safeParse({ ...common, language: "bilingual" }).success).toBe(true);
  });

  it("rejects the v2 fields — shapes must not blur together", () => {
    const { translation: _t, ...rest } = base;
    expect(profileSchemaV1.safeParse({ ...rest, language: "en" }).success).toBe(false);
  });
});
