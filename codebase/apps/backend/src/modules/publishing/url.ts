// FR-18.8 (design §8 "Article URL"): the live article's link — the user record's site URL
// (data) plus the per-site path (the mapper's knowledge, like the field names). Both sites
// always prefix the locale; Afnan's `em` posts live under a separate section.

const AFNAN_PROJECT = "5gz3ngjs";

export function articleUrl(
  projectId: string,
  siteUrl: string,
  doc: { slug: string; language: string; blogType?: string | null },
): string {
  const section = projectId === AFNAN_PROJECT && doc.blogType === "em" ? "em-blog" : "blog";
  return `${siteUrl.replace(/\/+$/, "")}/${doc.language}/${section}/${encodeURIComponent(doc.slug)}`;
}

/** The slug, language and blog type from a published Sanity document, if it carries them. */
export function linkFieldsOf(doc: Record<string, unknown> | null): { slug: string; language: string; blogType?: string } | null {
  const slug = (doc?.slug as { current?: string } | undefined)?.current;
  const language = doc?.language as string | undefined;
  if (!slug || !language) return null;
  return { slug, language, blogType: doc?.blogType as string | undefined };
}
