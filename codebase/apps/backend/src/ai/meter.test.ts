import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@post-automate/shared";
import { priceUsage } from "./meter";

// FR-15.4/15.7: cost tracking must never silently undercount, because the budget gates
// (FR-15.8/15.10) are only as trustworthy as the numbers they read. priceUsage is pure over
// the registry rows the caller read from ai_models, so the fixture stands in for the table.
const MODELS: ModelInfo[] = [
  { provider: "anthropic", model: "claude-sonnet-5", capability: "chat", inputPerMTokUsd: 3, outputPerMTokUsd: 15, perSearchUsd: 0.01 },
  { provider: "openai", model: "gpt-image-1", capability: "image", perImageUsd: 0.04 },
  { provider: "grok", model: "grok-4", capability: "chat" }, // registered, deliberately unpriced
  { provider: "tavily", model: "tavily-search", capability: "search", perSearchUsd: 0.008 },
];

describe("priceUsage (FR-15.4)", () => {
  it("prices token usage from the registry", () => {
    // claude-sonnet-5: $3/MTok in, $15/MTok out
    expect(priceUsage(MODELS, "anthropic", "claude-sonnet-5", { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(18, 10);
  });

  it("prices partial usage proportionally", () => {
    expect(priceUsage(MODELS, "anthropic", "claude-sonnet-5", { inputTokens: 500_000 })).toBeCloseTo(1.5, 10);
  });

  it("prices per-image and per-search units", () => {
    expect(priceUsage(MODELS, "openai", "gpt-image-1", { images: 2 })).toBeCloseTo(0.08, 10);
    expect(priceUsage(MODELS, "tavily", "tavily-search", { searches: 10 })).toBeCloseTo(0.08, 10);
  });

  it("costs nothing when no units were consumed", () => {
    expect(priceUsage(MODELS, "anthropic", "claude-sonnet-5", {})).toBe(0);
  });

  it("refuses a model that is not in the registry", () => {
    expect(() => priceUsage(MODELS, "anthropic", "claude-imaginary-9", { inputTokens: 1000 })).toThrow(
      /not in the registry/,
    );
  });

  it("refuses a registered model that has no price for the unit consumed", () => {
    // grok-4 is registered but unpriced — routing to it must fail loudly at metering rather
    // than record a $0 call. This is why an unpriced model is hidden from the route picker.
    expect(() => priceUsage(MODELS, "grok", "grok-4", { inputTokens: 1000 })).toThrow(/No input-token price/);
  });

  it("refuses a chat model billed for an unpriced capability", () => {
    expect(() => priceUsage(MODELS, "anthropic", "claude-sonnet-5", { images: 1 })).toThrow(/No per-image price/);
  });

  it("treats a price of zero as a real price, not a missing one", () => {
    // A free tier must not be mistaken for "unknown" — the two behave oppositely.
    const free: ModelInfo[] = [{ provider: "google", model: "free-tier", capability: "chat", inputPerMTokUsd: 0, outputPerMTokUsd: 0 }];
    expect(priceUsage(free, "google", "free-tier", { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });
});
