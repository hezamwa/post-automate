import type { ProviderAdapter } from "../types";

// Google Gemini adapter (design §6.1); Imagen available as an image route later.
// TODO(phase-1): implement chat() + healthCheck().
export const google: ProviderAdapter = {
  id: "google",
  capabilities: ["chat"],
  async chat() {
    throw new Error("google adapter not implemented yet");
  },
  async healthCheck() {
    throw new Error("google adapter not implemented yet");
  },
};
