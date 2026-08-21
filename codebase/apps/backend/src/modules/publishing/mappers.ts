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
