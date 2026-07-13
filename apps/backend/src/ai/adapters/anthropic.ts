import type { ProviderAdapter } from "../types";

// Anthropic adapter (design §6.1): official TS SDK via Cloudflare AI Gateway baseURL.
// Structured outputs via output_config.format; web search via the server-side search tool.
// TODO(phase-1): implement chat() + healthCheck().
export const anthropic: ProviderAdapter = {
  id: "anthropic",
  capabilities: ["chat", "search"],
  async chat() {
    throw new Error("anthropic adapter not implemented yet");
  },
  async healthCheck() {
    throw new Error("anthropic adapter not implemented yet");
  },
};
