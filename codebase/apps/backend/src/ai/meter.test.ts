import { describe, expect, it } from "vitest";
import { priceUsage } from "./meter";
import { MODEL_REGISTRY } from "./registry";

// FR-15.4/15.7: cost tracking must never silently undercount, because the budget gates
// (FR-15.8/15.10) are only as trustworthy as the numbers they read.
describe("priceUsage (FR-15.4)", () => {
  it("prices token usage from the registry", () => {
    // claude-sonnet-5: $3/MTok in, $15/MTok out
    expect(priceUsage("anthropic", "claude-sonnet-5", { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(18, 10);
  });

  it("prices partial usage proportionally", () => {
    expect(priceUsage("anthropic", "claude-sonnet-5", { inputTokens: 500_000 })).toBeCloseTo(1.5, 10);
  });

  it("prices per-image and per-search units", () => {
    expect(priceUsage("openai", "gpt-image-1", { images: 2 })).toBeCloseTo(0.08, 10);
    expect(priceUsage("brave", "brave-web-search", { searches: 10 })).toBeCloseTo(0.05, 10);
  });

  it("costs nothing when no units were consumed", () => {
    expect(priceUsage("anthropic", "claude-sonnet-5", {})).toBe(0);
  });

  it("refuses a model that is not in the registry", () => {
    expect(() => priceUsage("anthropic", "claude-imaginary-9", { inputTokens: 1000 })).toThrow(
      /not in the registry/,
    );
  });

  it("refuses a registered model that has no price for the unit consumed", () => {
    // grok-4 is registered but deliberately unpriced — routing to it must fail loudly
    // at metering rather than record a $0 call.
    expect(() => priceUsage("grok", "grok-4", { inputTokens: 1000 })).toThrow(/No input-token price/);
  });

  it("refuses a chat model billed for an unpriced capability", () => {
    expect(() => priceUsage("anthropic", "claude-sonnet-5", { images: 1 })).toThrow(/No per-image price/);
  });
});

describe("MODEL_REGISTRY (FR-15.4)", () => {
  it("has no duplicate provider/model entries", () => {
    const keys = MODEL_REGISTRY.map((m) => `${m.provider}/${m.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prices every chat model on both input and output, or neither", () => {
    // A half-priced model undercounts silently in one direction only — worse than unpriced.
    for (const m of MODEL_REGISTRY.filter((x) => x.capability === "chat")) {
      const priced = [m.inputPerMTokUsd, m.outputPerMTokUsd].filter((p) => p != null).length;
      expect(priced === 0 || priced === 2).toBe(true);
    }
  });
});
