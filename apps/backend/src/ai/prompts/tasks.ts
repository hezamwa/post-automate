import type { Language, Profile } from "@post-automate/shared";
import {
  audienceBlock,
  guardrailsBlock,
  LANGUAGE_NAMES,
  voiceBlock,
} from "./blocks";

// Task prompts + structured-output JSON schemas (design §6). Schemas follow OpenAI
// strict-mode rules (all properties required, additionalProperties: false) so they
// work natively on both Anthropic and OpenAI routes.

export interface TopicBrief {
  title: string;
  summary: string;
  whyItMatters: string;
  sourceUrls: string[];
}

export interface Angle {
  headline: string;
  thesis: string;
  whyThisCreator: string;
  outline: string[];
}

// ── discovery (FR-5.4/5.5/5.7) ────────────────────────────────────────────────

export const candidatesSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          whyItMatters: { type: "string" },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
        required: ["title", "summary", "whyItMatters", "sourceUrls"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

export function discoveryPrompt(profile: Profile, recentTopics: string[]): { system: string; user: string } {
  const recency =
    profile.domain.field === "medical"
      ? "Prioritize recency of RESEARCH — new studies, guideline updates, public-health advisories — over social-media buzz. Prefer primary sources (journals, WHO/CDC)."
      : "Prioritize recency of discussion — launches, releases, debates — and cite where the discussion is happening.";
  return {
    system: `You are a topic scout for a ${profile.domain.field} content creator. ${recency}
Search the web before answering; every candidate must cite at least one real source URL.
Exclude anything matching these banned topics: ${profile.topicPolicy.bannedTopics.join("; ") || "(none)"}.
Also exclude topics similar to these, covered or rejected in the last 30 days: ${recentTopics.join("; ") || "(none)"}.`,
    user: `Find 8-10 topics currently trending in: ${profile.domain.subNiches.join(", ")}. Return them as structured candidates.`,
  };
}

// ── targeted research for user-requested topics (FR-5.8) ─────────────────────

export const researchSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    whyItMatters: { type: "string" },
    keyFacts: { type: "array", items: { type: "string" } },
    sourceUrls: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "whyItMatters", "keyFacts", "sourceUrls"],
  additionalProperties: false,
} as const;

export function researchPrompt(
  profile: Profile,
  topic: { title: string; notes?: string; links?: string[] },
): { system: string; user: string } {
  return {
    system: `You research one specific topic for a ${profile.domain.field} content creator. The creator chose it — do not judge whether it is trending. Search the web; treat the creator's provided links as primary sources. Every key fact must tie to a source URL.`,
    user: `Topic: "${topic.title}"\nCreator notes: ${topic.notes ?? "(none)"}\nProvided sources: ${topic.links?.join(", ") ?? "(none)"}\nReturn a structured topic brief.`,
  };
}

// ── scoring (FR-5.2) ──────────────────────────────────────────────────────────

export const scoresSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          score: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["index", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

export function scoringPrompt(profile: Profile, candidates: TopicBrief[]): { system: string; user: string } {
  const interests = profile.topicPolicy.interests.map((i) => `${i.topic} (weight ${i.weight})`).join(", ");
  return {
    system: `You score topic candidates for this creator. Consider match to weighted interests [${interests}], audience fit [${profile.audience.description}], freshness, and whether the creator can add a distinctive angle. Score 1 (skip) to 10 (must write). Banned topics score 0 with reason "banned".`,
    user: candidates
      .map((c, i) => `#${i}: ${c.title} — ${c.summary} (why: ${c.whyItMatters})`)
      .join("\n"),
  };
}

// ── angles (FR-6.3) ───────────────────────────────────────────────────────────

export const anglesSchema = {
  type: "object",
  properties: {
    angles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          thesis: { type: "string" },
          whyThisCreator: { type: "string" },
          outline: { type: "array", items: { type: "string" } },
        },
        required: ["headline", "thesis", "whyThisCreator", "outline"],
        additionalProperties: false,
      },
    },
    recommendedIndex: { type: "integer" },
  },
  required: ["angles", "recommendedIndex"],
  additionalProperties: false,
} as const;

export function anglesPrompt(profile: Profile, topic: TopicBrief): { system: string; user: string } {
  return {
    system: [
      `You propose article angles for this creator.`,
      voiceBlock(profile),
      audienceBlock(profile),
      guardrailsBlock(profile),
      `Propose exactly 3 distinct angles (headline, thesis, whyThisCreator, outline of 3-5 sections) and set recommendedIndex to the strongest one.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    user: topicBriefText(topic),
  };
}

// ── article (FR-6.3 step 2, FR-6.5, FR-6.11) ─────────────────────────────────

export const articleSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    slug: { type: "string" },
    excerpt: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    imageAlt: { type: "string" },
    markdown: { type: "string" },
  },
  required: ["title", "slug", "excerpt", "tags", "imageAlt", "markdown"],
  additionalProperties: false,
} as const;

export function articleUser(topic: TopicBrief, angle: Angle): string {
  return `${topicBriefText(topic)}

SELECTED ANGLE:
Headline: ${angle.headline}
Thesis: ${angle.thesis}
Outline: ${angle.outline.join(" → ")}

Write the full article now. Also return: slug (URL-safe lowercase latin, hyphenated — transliterate if the title is Arabic), excerpt (1-2 sentences for listings/SEO, article language), tags (3-6), imageAlt (one sentence describing the hero illustration for accessibility, article language), and the full markdown.`;
}

function topicBriefText(topic: TopicBrief): string {
  return `TOPIC BRIEF:
Title: ${topic.title}
Summary: ${topic.summary}
Why now: ${topic.whyItMatters}
Sources: ${topic.sourceUrls.join(", ")}`;
}

// ── derivatives (FR-6.12–6.14) ───────────────────────────────────────────────

export function shortenXPrompt(profile: Profile): string {
  return [
    voiceBlock(profile),
    `Compress the article below into ONE X.com post: MAXIMUM 280 characters including hashtags (hashtag policy: ${profile.voice.hashtagPolicy}). Language: ${profile.primaryLanguage}. Keep the hook, drop the detail, end with value — no clickbait. Reply with the post text only.`,
  ].join("\n\n");
}

export function shortenLinkedInPrompt(profile: Profile): string {
  return [
    voiceBlock(profile),
    `Rewrite the article below as ONE LinkedIn post (max 3000 characters; professional register; language: ${profile.primaryLanguage}). Structure: a strong first line (it shows before "see more"), 2-4 short paragraphs of substance, a closing line inviting the full read. At most 3 hashtags. Reply with the post text only.`,
  ].join("\n\n");
}

// FR-6.14: the target comes from profile.translation.targetLanguage — or, for the
// Phase-2 per-draft override, from the request — never inferred from primaryLanguage.
export function translatePrompt(targetLanguage: Language): string {
  return `Translate the article below into ${LANGUAGE_NAMES[targetLanguage]}. Preserve the Markdown structure, tone, and the meaning of any disclaimer block exactly. Do not add or remove claims. Reply with the translated Markdown only.`;
}

export function imagePrompt(headline: string, profile: Profile): string {
  const medical =
    profile.domain.field === "medical"
      ? " Abstract/schematic only — no realistic patients, procedures, or identifiable people."
      : "";
  return `Editorial hero illustration for an article titled "${headline}". Clean, modern, no text overlay, no logos.${medical}`;
}
