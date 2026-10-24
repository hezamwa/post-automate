import { describe, expect, it } from "vitest";
import { accumulateUsage, anthropicSystem } from "./anthropic";
import { usageFromGemini } from "./google";
import { usageFromCompletion, usageFromResponses } from "./openai-compat";

// Cached tokens reach the ledger split from uncached input (FR-15.7, spec §3 "prompt
// caching"): Anthropic reports them beside input_tokens, OpenAI and Gemini inside the
// prompt total. Each adapter normalises to the same Usage shape.

describe("anthropic", () => {
  it("puts cache_control on the flagged system block only", () => {
    expect(anthropicSystem([{ text: "stable", cache: true }, { text: "volatile" }])).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile" },
    ]);
    expect(anthropicSystem("plain")).toBe("plain");
  });

  it("accumulates uncached input, cache reads and cache writes separately across resumes", () => {
    const usage = {};
    accumulateUsage(usage, { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } as never });
    accumulateUsage(usage, { usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: 700 } as never });
    expect(usage).toEqual({ inputTokens: 150, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 700 });
  });
});

describe("openai-compatible", () => {
  it("subtracts cached tokens from the prompt total (chat completions and responses)", () => {
    expect(usageFromCompletion({ prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } })).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 800,
    });
    expect(usageFromResponses({ input_tokens: 500, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } })).toEqual({
      inputTokens: 400,
      outputTokens: 5,
      cacheReadTokens: 100,
    });
  });

  it("reports plain usage without cache details and nothing when usage is missing", () => {
    expect(usageFromCompletion({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(usageFromCompletion(undefined)).toEqual({ inputTokens: undefined, outputTokens: undefined });
  });
});

describe("gemini", () => {
  it("splits cachedContentTokenCount out of promptTokenCount", () => {
    expect(usageFromGemini({ promptTokenCount: 300, candidatesTokenCount: 7, cachedContentTokenCount: 250 })).toEqual({
      inputTokens: 50,
      outputTokens: 7,
      cacheReadTokens: 250,
    });
  });
});
