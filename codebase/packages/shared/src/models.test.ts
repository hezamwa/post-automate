import { describe, expect, it } from "vitest";
import { TASK_TYPES } from "./ai";
import { modelRejection, modelsForTask, providersForTask, routeRejection, type ModelInfo } from "./models";

// The route picker and the /admin/ai/routes validator call these same functions, so these
// tests pin the rule for both (FR-15.2/15.4). The fixture mirrors what migration 0010 seeds
// into ai_models — the rule is pure, so the real table is exercised in the backend's tests.
const MODELS: ModelInfo[] = [
  { provider: "anthropic", model: "claude-sonnet-5", capability: "chat", inputPerMTokUsd: 3, outputPerMTokUsd: 15, perSearchUsd: 0.01 },
  { provider: "anthropic", model: "claude-haiku-4-5", capability: "chat", inputPerMTokUsd: 1, outputPerMTokUsd: 5, perSearchUsd: 0.01 },
  { provider: "openai", model: "gpt-image-1", capability: "image", perImageUsd: 0.04 },
  { provider: "openai", model: "gpt-5-mini", capability: "chat", inputPerMTokUsd: 0.25, outputPerMTokUsd: 2, perSearchUsd: 0.01 },
  { provider: "grok", model: "grok-4", capability: "chat" }, // registered, never priced
  { provider: "tavily", model: "tavily-search", capability: "search", perSearchUsd: 0.008 },
  { provider: "tavily", model: "tavily-unpriced", capability: "search" },
];

describe("routeRejection", () => {
  it("accepts the models discovery actually runs on", () => {
    // Regression guard: discovery/research are search TASKS served by CHAT models with
    // LLM-native web search. A capability rule written from the task's name instead of the
    // router's dispatch would hide these and empty the picker for the live config.
    expect(routeRejection(MODELS, "anthropic", "claude-sonnet-5", "discovery")).toBeNull();
    expect(routeRejection(MODELS, "openai", "gpt-5-mini", "discovery")).toBeNull();
    expect(routeRejection(MODELS, "anthropic", "claude-sonnet-5", "research")).toBeNull();
  });

  it("rejects a model whose capability cannot serve the task", () => {
    expect(routeRejection(MODELS, "openai", "gpt-image-1", "article")).toMatch(/needs a 'chat' model/);
    expect(routeRejection(MODELS, "anthropic", "claude-sonnet-5", "image")).toMatch(/needs a 'image' model/);
    // A search model serves the web_search task and nothing else: the chat tasks dispatch
    // through adapter.chat, which it does not have.
    for (const task of TASK_TYPES.filter((t) => t !== "web_search")) {
      expect(routeRejection(MODELS, "tavily", "tavily-search", task)).not.toBeNull();
    }
    expect(routeRejection(MODELS, "tavily", "tavily-search", "web_search")).toBeNull();
  });

  it("rejects an unpriced model — it would bill the provider then fail at metering", () => {
    expect(routeRejection(MODELS, "grok", "grok-4", "article")).toMatch(/no token prices/);
    // Same rule for a search provider: its unit is the search, so that is the price it needs.
    expect(routeRejection(MODELS, "tavily", "tavily-unpriced", "web_search")).toMatch(/no per-search price/);
  });

  it("rejects a chat model with no per-search price for a searching task", () => {
    // Priced for chat but not for search: fine for article, refused for discovery.
    const priced: ModelInfo = { provider: "openai", model: "no-search-1", capability: "chat", inputPerMTokUsd: 1, outputPerMTokUsd: 2 };
    expect(modelRejection(priced, "discovery")).toMatch(/web search/i);
    expect(modelRejection(priced, "research")).toMatch(/web search/i);
    expect(modelRejection(priced, "article")).toBeNull();
  });

  it("rejects a model that is not registered at all", () => {
    expect(routeRejection(MODELS, "anthropic", "claude-imaginary-9", "article")).toMatch(/not registered/);
  });
});

describe("modelsForTask", () => {
  it("offers only models that pass the rule, and narrows by provider", () => {
    const forArticle = modelsForTask(MODELS, "article").map((m) => m.model);
    expect(forArticle).toContain("claude-haiku-4-5");
    expect(forArticle).not.toContain("gpt-image-1");
    expect(forArticle).not.toContain("grok-4"); // unpriced

    expect(modelsForTask(MODELS, "article", "anthropic").every((m) => m.provider === "anthropic")).toBe(true);
    expect(modelsForTask(MODELS, "image").map((m) => m.model)).toEqual(["gpt-image-1"]);
    // web_search offers the priced search model only
    expect(modelsForTask(MODELS, "web_search").map((m) => m.model)).toEqual(["tavily-search"]);
  });

  it("returns nothing for capabilities no registered model has (FR-6.15)", () => {
    expect(modelsForTask(MODELS, "voice")).toEqual([]);
    expect(modelsForTask(MODELS, "video")).toEqual([]);
    expect(providersForTask(MODELS, "voice")).toEqual([]);
  });

  it("surfaces a provider as soon as one of its models qualifies", () => {
    // What "add a provider" actually means now: one priced row, no deploy.
    const withDeepseek: ModelInfo[] = [
      ...MODELS,
      { provider: "deepseek", model: "deepseek-chat", capability: "chat", inputPerMTokUsd: 0.28, outputPerMTokUsd: 0.42 },
    ];
    expect(providersForTask(MODELS, "article")).not.toContain("deepseek");
    expect(providersForTask(withDeepseek, "article")).toContain("deepseek");
    // ...but not for a searching task until it has a per-search price
    expect(providersForTask(withDeepseek, "discovery")).not.toContain("deepseek");
  });

  it("never offers a model the validator would reject", () => {
    for (const task of TASK_TYPES) {
      for (const m of modelsForTask(MODELS, task)) {
        expect(routeRejection(MODELS, m.provider, m.model, task)).toBeNull();
      }
    }
  });
});
