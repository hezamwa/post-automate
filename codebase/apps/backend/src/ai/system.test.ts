import { describe, expect, it } from "vitest";
import { systemBlocks, systemText } from "./system";

// The cache breakpoint (design §6): after the last STABLE block, surviving empty blocks.
describe("systemBlocks", () => {
  it("flags the breakpoint block and drops empty ones", () => {
    expect(systemBlocks(["rules", "voice", "", "examples"], 3)).toEqual([
      { text: "rules" },
      { text: "voice" },
      { text: "examples", cache: true },
    ]);
  });

  it("moves the breakpoint back to the last non-empty block at or before it", () => {
    // guardrails (index 3) is empty for a tech profile — the flag lands on audience
    expect(systemBlocks(["rules", "voice", "audience", ""], 3)).toEqual([
      { text: "rules" },
      { text: "voice" },
      { text: "audience", cache: true },
    ]);
  });

  it("sets no flag without a breakpoint, and flattens to text for providers that cache on their own", () => {
    expect(systemBlocks(["a", "b"])).toEqual([{ text: "a" }, { text: "b" }]);
    expect(systemText([{ text: "a", cache: true }, { text: "b" }])).toBe("a\n\nb");
    expect(systemText("plain")).toBe("plain");
    expect(systemText(undefined)).toBe("");
  });
});
