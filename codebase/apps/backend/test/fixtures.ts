import type { Profile } from "@post-automate/shared";

/** Minimal valid tech profile — every field the schema demands, nothing more. */
export function techProfile(overrides: Partial<Profile> = {}): Profile {
  return {
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
    format: { type: "article", targetWords: 1200 },
    examplePosts: ["example one", "example two"],
    aiDisclosure: false,
    channels: ["x", "linkedin"],
    ...overrides,
  } as Profile;
}
