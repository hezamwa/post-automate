import { describe, expect, it } from "vitest";
import { articleUrl, linkFieldsOf } from "./url";

// FR-18.8: site URL (data) + the per-site path; locale always prefixed.
describe("articleUrl", () => {
  it("builds each site's path; Afnan's em posts under em-blog", () => {
    expect(articleUrl("r9zdt0s0", "https://waleedalhezam.sa/", { slug: "ai-tools", language: "en" })).toBe("https://waleedalhezam.sa/en/blog/ai-tools");
    expect(articleUrl("5gz3ngjs", "https://afnanalmass.sa", { slug: "heart", language: "ar", blogType: "public" })).toBe("https://afnanalmass.sa/ar/blog/heart");
    expect(articleUrl("5gz3ngjs", "https://afnanalmass.sa", { slug: "stemi", language: "en", blogType: "em" })).toBe("https://afnanalmass.sa/en/em-blog/stemi");
  });

  it("reads the link fields from a published document, or null when missing", () => {
    expect(linkFieldsOf({ slug: { current: "a" }, language: "en", blogType: "em" })).toEqual({ slug: "a", language: "en", blogType: "em" });
    expect(linkFieldsOf({ slug: { current: "a" } })).toBeNull();
    expect(linkFieldsOf(null)).toBeNull();
  });
});
