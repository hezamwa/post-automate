// Per-site document mappers (FR-8.2, design §8): each site keeps its own blog type;
// the pipeline satisfies each site's required fields. Adding a site = adding a mapper.
import type { Profile } from "@post-automate/shared";
import { PROMPT_VERSION } from "../../ai/prompts/blocks";
import type { Article, DerivedTexts } from "../generation";
import { markdownToPortableText } from "./portable-text";

export interface MapperInput {
  article: Article;
  texts: DerivedTexts;
  profile: Profile;
  runId: string;
  provider: string;
  model: string;
  imageAssetId?: string;
  /** Afnan only: public|em — captured at her Phase-2 onboarding (design §8). */
  blogType?: "public" | "em";
}

function generationMeta(input: MapperInput) {
  return {
    provider: input.provider,
    model: input.model,
    promptVersion: PROMPT_VERSION,
    pipelineRunId: input.runId,
    sourceUrls: [] as string[], // filled by the caller from the topic brief
  };
}

/** waleedalhezam.sa — type `post` (project r9zdt0s0). */
export function mapToWaleedPost(input: MapperInput): Record<string, unknown> {
  const { article, texts, profile } = input;
  return {
    _type: "post",
    title: article.title,
    slug: { _type: "slug", current: article.slug },
    language: profile.primaryLanguage,
    ...(input.imageAssetId
      ? { image: { _type: "image", asset: { _type: "reference", _ref: input.imageAssetId }, alt: article.imageAlt } }
      : {}),
    excerpt: article.excerpt,
    datePublished: new Date().toISOString(), // refreshed at publish time (design §8)
    categories: [],
    tags: article.tags,
    content: markdownToPortableText(article.markdown),
    ...(texts.xVersion ? { xVersion: texts.xVersion } : {}),
    ...(texts.linkedinVersion ? { linkedinVersion: texts.linkedinVersion } : {}),
    aiDisclosure: profile.aiDisclosure ?? false,
    generationMeta: generationMeta(input),
  };
}

/** afnanalmass.sa — type `blogPost` (project 5gz3ngjs). */
export function mapToAfnanBlogPost(input: MapperInput): Record<string, unknown> {
  const { article, texts, profile } = input;
  return {
    _type: "blogPost",
    blogType: input.blogType ?? "public",
    title: article.title,
    slug: { _type: "slug", current: article.slug },
    language: profile.primaryLanguage,
    publishDate: new Date().toISOString(),
    ...(input.imageAssetId
      ? {
          featuredImage: {
            _type: "image",
            asset: { _type: "reference", _ref: input.imageAssetId },
            alt: article.imageAlt, // required on her site (design §8)
          },
        }
      : {}),
    excerpt: article.excerpt,
    body: markdownToPortableText(article.markdown),
    tags: article.tags,
    ...(texts.xVersion ? { xVersion: texts.xVersion } : {}),
    ...(texts.linkedinVersion ? { linkedinVersion: texts.linkedinVersion } : {}),
    aiDisclosure: profile.aiDisclosure ?? false,
    generationMeta: generationMeta(input),
  };
}

const MAPPERS: Record<string, (input: MapperInput) => Record<string, unknown>> = {
  r9zdt0s0: mapToWaleedPost,
  "5gz3ngjs": mapToAfnanBlogPost,
};

export function mapForProject(projectId: string, input: MapperInput): Record<string, unknown> {
  const mapper = MAPPERS[projectId];
  if (!mapper) {
    throw new Error(`No publishing mapper for Sanity project ${projectId} — add one in mappers.ts (FR-8.2)`);
  }
  return mapper(input);
}

// ── Translated second document (FR-6.14, design §8) — built at publish time ─────────
// Waleed: an independent `post` per language. Afnan: a `blogPost` linked to the primary
// via her document-internationalization plugin's translation.metadata document.

export interface TranslatedDocInput {
  runId: string;
  targetLanguage: "ar" | "en";
  title: string;
  excerpt: string;
  imageAlt: string;
  markdown: string;
  baseSlug: string; // original article slug; translated doc uses `${baseSlug}-${lang}`
  tags: string[];
  aiDisclosure: boolean;
  provider: string;
  model: string;
  imageAssetId?: string;
  blogType?: "public" | "em";
  sourceUrls: string[];
}

export function translatedDocId(runId: string, lang: string): string {
  return `postauto-${runId}-${lang}`; // deterministic → retract can find it (AR-10.3 spirit)
}

export function translationMetadataId(runId: string): string {
  return `postauto-${runId}-i18n`;
}

export function mapTranslatedForProject(projectId: string, input: TranslatedDocInput): Record<string, unknown> {
  const image = input.imageAssetId
    ? { _type: "image", asset: { _type: "reference", _ref: input.imageAssetId }, alt: input.imageAlt }
    : undefined;
  const meta = {
    provider: input.provider,
    model: input.model,
    promptVersion: PROMPT_VERSION,
    pipelineRunId: input.runId,
    sourceUrls: input.sourceUrls,
  };
  if (projectId === "5gz3ngjs") {
    return {
      _type: "blogPost",
      _id: translatedDocId(input.runId, input.targetLanguage),
      language: input.targetLanguage, // plugin-managed field, set explicitly here
      blogType: input.blogType ?? "public",
      title: input.title,
      slug: { _type: "slug", current: `${input.baseSlug}-${input.targetLanguage}` },
      publishDate: new Date().toISOString(),
      ...(image ? { featuredImage: image } : {}), // alt required on her site (design §8)
      excerpt: input.excerpt,
      body: markdownToPortableText(input.markdown),
      tags: input.tags,
      aiDisclosure: input.aiDisclosure,
      generationMeta: meta,
    };
  }
  return {
    _type: "post",
    _id: translatedDocId(input.runId, input.targetLanguage),
    language: input.targetLanguage, // his site: one independent document per language
    title: input.title,
    slug: { _type: "slug", current: `${input.baseSlug}-${input.targetLanguage}` },
    ...(image ? { image } : {}),
    excerpt: input.excerpt,
    datePublished: new Date().toISOString(),
    categories: [],
    tags: input.tags,
    content: markdownToPortableText(input.markdown),
    aiDisclosure: input.aiDisclosure,
    generationMeta: meta,
  };
}

/**
 * Afnan's i18n linkage (@sanity/document-internationalization): one translation.metadata
 * document referencing both language editions. WEAK references, as the plugin writes
 * them — a strong ref would block retracting (unpublishing) either edition (FR-7.6).
 */
export function translationMetadataDoc(
  runId: string,
  schemaType: string,
  entries: { lang: string; docId: string }[],
): Record<string, unknown> {
  return {
    _type: "translation.metadata",
    _id: translationMetadataId(runId),
    schemaTypes: [schemaType],
    translations: entries.map((e) => ({
      _key: e.lang,
      value: { _type: "reference", _ref: e.docId, _weak: true },
    })),
  };
}
