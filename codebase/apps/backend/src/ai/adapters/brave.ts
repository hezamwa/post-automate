import type { ProviderAdapter } from "../types";

// Brave Search adapter — SEARCH capability only (no chat). Raw web results feed the
// discovery/research tasks as a two-step alternative to LLM-native web search:
// brave.search(query) → results injected into the topic brief → LLM synthesis.
// API: https://api.search.brave.com/res/v1/web/search (X-Subscription-Token header).
// TODO(phase-1, optional): implement search() + healthCheck().
export const brave: ProviderAdapter = {
  id: "brave",
  capabilities: ["search"],
  async search() {
    throw new Error("brave adapter not implemented yet");
  },
  async healthCheck() {
    throw new Error("brave adapter not implemented yet");
  },
};
