import { profileSchema, type Profile } from "@post-automate/shared";

type ProfileOverrides = Partial<Omit<Profile, "gates">> & { gates?: Partial<Profile["gates"]> };

/** Minimal valid tech profile — every field the schema demands, nothing more; defaults applied. */
export function techProfile(overrides: ProfileOverrides = {}): Profile {
  const { gates, ...rest } = overrides;
  return profileSchema.parse({
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
    ...rest,
    ...(gates ? { gates } : {}),
  });
}

/** Every pre-draft gate set to ask — the guided run of spec §4.2. */
export const GUIDED_GATES: Profile["gates"] = { topic: "ask", angle: "ask", outline: "ask", image: "ask", derivatives: "ask", publish: "ask" };
