// Drop-in Sanity Studio schema — copy this file into EACH site's Studio schema folder
// (Waleed: r9zdt0s0, Afnan: 5gz3ngjs) and register it in the schema index.
// Source of truth: post-automate docs/design.md §8 (FR-8.2). Keep the two copies in sync.
import { defineField, defineType } from "sanity";

export const post = defineType({
  name: "post",
  title: "Post",
  type: "document",
  fields: [
    defineField({ name: "title", type: "string", validation: (r) => r.required() }),
    defineField({
      name: "language",
      type: "string",
      options: { list: ["ar", "en", "bilingual"] },
    }),
    defineField({ name: "author", type: "reference", to: [{ type: "author" }] }),
    defineField({ name: "mainImage", type: "image", title: "Hero image" }), // FR-6.13
    defineField({ name: "body", type: "array", of: [{ type: "block" }] }),
    defineField({
      name: "bodyTranslated",
      title: "Body (translation)",
      type: "array",
      of: [{ type: "block" }], // FR-6.14 — bilingual profiles
    }),
    defineField({
      name: "xVersion",
      title: "X.com version",
      type: "text",
      description: "Short X/Twitter version generated with the article (FR-6.12)",
    }),
    defineField({
      name: "linkedinVersion",
      title: "LinkedIn version",
      type: "text",
      description: "LinkedIn post version generated with the article (FR-6.12)",
    }),
    defineField({ name: "tags", type: "array", of: [{ type: "string" }] }),
    defineField({
      name: "aiDisclosure",
      type: "boolean",
      initialValue: false,
      description: "When true, the site renders an 'AI-assisted, reviewed by author' note (FR-6.18)",
    }),
    defineField({
      name: "generationMeta",
      type: "object",
      readOnly: true, // written by the pipeline; gold for debugging "why did it write this"
      fields: [
        defineField({ name: "provider", type: "string" }),
        defineField({ name: "model", type: "string" }),
        defineField({ name: "promptVersion", type: "string" }),
        defineField({ name: "pipelineRunId", type: "string" }),
        defineField({ name: "sourceUrls", type: "array", of: [{ type: "url" }] }),
      ],
    }),
  ],
  preview: {
    select: { title: "title", media: "mainImage", subtitle: "language" },
  },
});
