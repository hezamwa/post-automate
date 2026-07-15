// Minimal author schema — ONLY needed if a site's Studio doesn't already define `author`.
// If the site already has one, skip this file; `post.author` just needs a reference target.
import { defineField, defineType } from "sanity";

export const author = defineType({
  name: "author",
  title: "Author",
  type: "document",
  fields: [
    defineField({ name: "name", type: "string", validation: (r) => r.required() }),
    defineField({ name: "image", type: "image" }),
    defineField({ name: "bio", type: "text" }),
  ],
});
