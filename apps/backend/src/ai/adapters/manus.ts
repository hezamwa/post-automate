import type { ProviderAdapter } from "../types";

// Manus adapter — agent-platform API, NOT a standard chat-completions surface.
// Verify the current Manus API shape (task/session-based) before implementing, and map
// it onto ChatRequest/ChatResult or a dedicated capability as appropriate (design §13).
// TODO(when first routed): implement + decide capability mapping.
export const manus: ProviderAdapter = {
  id: "manus",
  capabilities: ["chat"],
  async chat() {
    throw new Error("manus adapter not implemented yet — verify Manus API shape first (design §13)");
  },
  async healthCheck() {
    throw new Error("manus adapter not implemented yet");
  },
};
