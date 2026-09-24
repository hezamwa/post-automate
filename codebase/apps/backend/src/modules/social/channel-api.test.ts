import { describe, expect, it } from "vitest";
import { withLink } from "./channel-api";
import { LINKEDIN_MAX_POST_CHARS } from "./linkedin-posts";

// OD-27 revised: LinkedIn carries the article link on the post's last line; a long text is
// trimmed so the link always fits.
describe("withLink", () => {
  const url = "https://afnanalmass.sa/en/blog/heart";
  it("appends the link on its own line", () => {
    expect(withLink("Short text", url)).toBe(`Short text\n\n${url}`);
  });
  it("trims a text that would push the link past the limit", () => {
    const out = withLink("x".repeat(LINKEDIN_MAX_POST_CHARS), url);
    expect(out.length).toBeLessThanOrEqual(LINKEDIN_MAX_POST_CHARS);
    expect(out.endsWith(`…\n\n${url}`)).toBe(true);
  });
});
