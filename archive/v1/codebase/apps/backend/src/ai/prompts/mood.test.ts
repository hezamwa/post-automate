import { describe, expect, it } from "vitest";
import { profileSchema } from "@post-automate/shared";
import { buildDeriveLinkedInPrompt } from "../../workflows/prompts/derive-linkedin";
import { buildDeriveXPrompt } from "../../workflows/prompts/derive-x";
import { buildDraftPrompt } from "../../workflows/prompts/draft";
import { moodBlock } from "./blocks";

// FR-6.19–6.20 (design §6 "Mood block"): a non-normal mood adds ONE line after VOICE and
// before the guardrails, in the article and both channel prompts; normal adds nothing.

const profile = profileSchema.parse({
  identity: { displayName: "T" },
  domain: { field: "medical", subNiches: ["cardiology"] },
  voice: { tone: ["warm"], formality: "neutral", sentenceLength: "mixed", emojiPolicy: "never", hashtagPolicy: "few", hookStyle: "question" },
  audience: { description: "patients", expertiseLevel: "general" },
  topicPolicy: { interests: [{ topic: "heart", weight: 5 }], bannedTopics: [] },
  cadence: { postsPerWeek: 1, preferredDays: ["mon"], preferredHourUtc: 9 },
  primaryLanguage: "en",
  translation: { enabled: false },
  examplePosts: ["a", "b"],
  compliance: { noDiagnosis: true, noDosage: true, noCaseReferences: true, disclaimerText: "Not advice." },
});
const topic = { title: "t", summary: "s", whyItMatters: "w", sourceUrls: [] };
const angle = { headline: "h", thesis: "t", whyThisCreator: "w", outline: [] };
const text = (system: unknown) => JSON.stringify(system);

describe("mood block", () => {
  it("normal (or absent) adds nothing", () => {
    expect(moodBlock("normal")).toBe("");
    expect(moodBlock(undefined)).toBe("");
    const plain = buildDraftPrompt({ profile, topic, angle, approvedExamples: [] });
    expect(buildDraftPrompt({ profile, mood: "normal", topic, angle, approvedExamples: [] }).system).toEqual(plain.system);
    expect(text(plain.system)).not.toContain("MOOD");
  });

  it("sits after VOICE and before the guardrails in the article prompt", () => {
    const system = buildDraftPrompt({ profile, mood: "concerned", topic, angle, approvedExamples: [] }).system as string[];
    const at = (needle: string) => system.findIndex((b) => b.includes(needle));
    expect(at("MOOD — for this piece, lean concerned")).toBe(at("VOICE") + 1);
    expect(at("MOOD")).toBeLessThan(at("NON-NEGOTIABLE"));
  });

  it("reaches both channel prompts", () => {
    expect(text(buildDeriveXPrompt({ profile, mood: "very_excited", markdown: "# a" }).system)).toContain("lean very excited");
    expect(text(buildDeriveLinkedInPrompt({ profile, mood: "optimistic", markdown: "# a" }).system)).toContain("lean optimistic");
  });
});
