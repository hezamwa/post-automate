import type { Mood, Profile } from "@post-automate/shared";
import { audienceBlock, editorialRules, fewShotBlock, guardrailsBlock, moodBlock, voiceBlock } from "../../ai/prompts/blocks";
import type { PromptSpec } from "../../ai/prompts/spec";
import type { TopicBrief } from "../../modules/discovery/types";
import type { Angle, Outline } from "../../modules/generation/types";
import { topicBriefText } from "./angles";
import { sourcesBlock } from "./outline";

// The article (FR-6.3 step 2, FR-6.5, FR-6.11; design §6 "Template: article generation").
// System = EDITORIAL + VOICE + AUDIENCE + GUARDRAILS + FEW_SHOT — all stable per profile,
// so the cache breakpoint sits after the last block; the brief/angle/revision is volatile.

export const PROMPT_VERSION = "v1";

export const articleJsonSchema = {
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

export interface DraftPromptInput {
  profile: Profile;
  /** FR-6.19: the run's mood — a line after VOICE; absent or normal adds nothing. */
  mood?: Mood;
  topic: TopicBrief;
  angle: Angle;
  /** 2–3 most recently approved posts (FR-6.2); empty → profile.examplePosts. */
  approvedExamples: string[];
  /** Revise-with-instructions (FR-7.9): the current draft replaces the brief. */
  revision?: { currentMarkdown: string; instructions: string };
  /** The approved outline (spec §3 step 6) and fetched source excerpts (step 4) — the grounding. */
  outline?: Outline | null;
  sources?: Array<{ url: string; excerpt: string }>;
}

function outlineText(outline: Outline | null | undefined): string {
  if (!outline) return "";
  return `APPROVED OUTLINE — follow these sections in order:\n${outline.sections.map((s, i) => `${i + 1}. ${s.heading}\n   - ${s.keyPoints.join("\n   - ")}`).join("\n")}`;
}

function articleRequest(topic: TopicBrief, angle: Angle, outline: Outline | null | undefined, sources: Array<{ url: string; excerpt: string }>): string {
  return [
    topicBriefText(topic),
    `SELECTED ANGLE:\nHeadline: ${angle.headline}\nThesis: ${angle.thesis}${outline ? "" : `\nOutline: ${angle.outline.join(" → ")}`}`,
    outlineText(outline),
    sourcesBlock(sources),
    `Write the full article now. Also return: slug (URL-safe lowercase latin, hyphenated — transliterate if the title is Arabic), excerpt (1-2 sentences for listings/SEO, article language), tags (3-6), imageAlt (one sentence describing the hero illustration for accessibility, article language), and the full markdown.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function revisionRequest(revision: { currentMarkdown: string; instructions: string }): string {
  return `Here is the current draft:\n\n${revision.currentMarkdown}\n\nRevise it according to these instructions from the creator, keeping every editorial and compliance rule intact:\n"${revision.instructions}"\n\nReturn the full revised article with updated slug/excerpt/tags/imageAlt.`;
}

export function buildDraftPrompt(input: DraftPromptInput): PromptSpec {
  const { profile, approvedExamples } = input;
  const system = [
    editorialRules(profile),
    voiceBlock(profile),
    ...[moodBlock(input.mood)].filter(Boolean), // only a non-normal mood adds a block
    audienceBlock(profile),
    guardrailsBlock(profile),
    fewShotBlock(approvedExamples.length > 0 ? approvedExamples : profile.examplePosts),
  ];
  return {
    version: PROMPT_VERSION,
    system,
    cacheBreakpointAfter: system.length - 1, // everything above is per-profile stable
    messages: [
      { role: "user", content: input.revision ? revisionRequest(input.revision) : articleRequest(input.topic, input.angle, input.outline, input.sources ?? []) },
    ],
    jsonSchema: articleJsonSchema,
    maxTokens: 16000,
  };
}
