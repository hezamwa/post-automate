import { describe, expect, it } from "vitest";
import {
  mapTranslatedForProject,
  translatedDocId,
  translationMetadataDoc,
  translationMetadataId,
  type TranslatedDocInput,
} from "./mappers";

// The translated second document (FR-6.14, design §8): per-site shape, deterministic
// ids, and — for Afnan — the i18n plugin's metadata document with WEAK references
// (a strong ref would block retracting either edition, FR-7.6).

const input: TranslatedDocInput = {
  runId: "run-1",
  targetLanguage: "ar",
  title: "عنوان",
  excerpt: "ملخص",
  imageAlt: "وصف الصورة",
  markdown: "# مرحبا\n\nنص المقال.",
  baseSlug: "hello-world",
  tags: ["health"],
  aiDisclosure: false,
  provider: "anthropic",
  model: "claude-sonnet-5",
  imageAssetId: "image-abc",
  blogType: "public",
  sourceUrls: ["https://who.int/x"],
};

describe("mapTranslatedForProject (design §8)", () => {
  it("builds Afnan's blogPost edition: language, blogType, suffixed slug, required alt", () => {
    const doc = mapTranslatedForProject("5gz3ngjs", input);
    expect(doc).toMatchObject({
      _type: "blogPost",
      _id: "postauto-run-1-ar",
      language: "ar",
      blogType: "public",
      title: "عنوان",
      slug: { current: "hello-world-ar" },
      excerpt: "ملخص",
      aiDisclosure: false,
    });
    expect((doc.featuredImage as { alt: string }).alt).toBe("وصف الصورة"); // required on her site
    expect(Array.isArray(doc.body)).toBe(true); // Portable Text, never raw markdown (FR-8.3)
    expect((doc.generationMeta as { sourceUrls: string[] }).sourceUrls).toEqual(["https://who.int/x"]);
  });

  it("builds Waleed's independent post edition with his language field", () => {
    const doc = mapTranslatedForProject("r9zdt0s0", input);
    expect(doc).toMatchObject({
      _type: "post",
      _id: "postauto-run-1-ar",
      language: "ar",
      slug: { current: "hello-world-ar" },
    });
    expect(Array.isArray(doc.content)).toBe(true);
    expect(doc.blogType).toBeUndefined(); // his site has no blogType
  });

  it("omits the image entirely when no asset exists — never a broken reference", () => {
    const doc = mapTranslatedForProject("5gz3ngjs", { ...input, imageAssetId: undefined });
    expect(doc.featuredImage).toBeUndefined();
  });
});

describe("translationMetadataDoc (Afnan's i18n plugin linkage)", () => {
  it("links both editions with WEAK references under a deterministic id", () => {
    const meta = translationMetadataDoc("run-1", "blogPost", [
      { lang: "en", docId: "postauto-run-1" },
      { lang: "ar", docId: translatedDocId("run-1", "ar") },
    ]);
    expect(meta).toMatchObject({
      _type: "translation.metadata",
      _id: translationMetadataId("run-1"),
      schemaTypes: ["blogPost"],
    });
    const translations = meta.translations as { _key: string; value: { _ref: string; _weak: boolean } }[];
    expect(translations.map((t) => t._key)).toEqual(["en", "ar"]);
    expect(translations.every((t) => t.value._weak === true)).toBe(true); // retract must stay possible
    expect(translations[1]?.value._ref).toBe("postauto-run-1-ar");
  });
});
