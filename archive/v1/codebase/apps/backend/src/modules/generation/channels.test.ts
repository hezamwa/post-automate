import { describe, expect, it } from "vitest";
import { fitToLimit } from "./channels";

// FR-6.12: a channel text is never over its limit — X refuses an over-long post (403).
describe("fitToLimit", () => {
  it("leaves a text within the limit untouched", () => {
    expect(fitToLimit("short enough", 280)).toBe("short enough");
    expect(fitToLimit("x".repeat(280), 280)).toBe("x".repeat(280));
  });
  it("trims at a word boundary with an ellipsis", () => {
    const out = fitToLimit("alpha beta gamma delta epsilon", 20);
    expect(out).toBe("alpha beta gamma…");
    expect([...out].length).toBeLessThanOrEqual(20);
  });
  it("counts code points, so Arabic and emoji are never split", () => {
    const out = fitToLimit("🇸🇦 ".repeat(200), 280);
    expect([...out].length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
  });
});
