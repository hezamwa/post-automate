import type { ProviderId } from "@post-automate/shared";
import type { Env } from "../../shared/env";
import type { ProviderAdapter } from "../types";
import { createAnthropicAdapter } from "./anthropic";
import { brave } from "./brave";
import { google } from "./google";
import { manus } from "./manus";
import { openAiCompat } from "./openai-compat";

// The router's single entry to adapters (AR-10.9). One adapter per provider family:
// openai-compat serves five providers by baseURL+key swap (design §6.1).
export function getAdapter(provider: ProviderId, env: Env): ProviderAdapter {
  switch (provider) {
    case "anthropic":
      return createAnthropicAdapter(env);
    case "openai":
    case "deepseek":
    case "moonshot":
    case "qwen":
    case "grok":
      return openAiCompat(provider, env);
    case "google":
      return google;
    case "brave":
      return brave;
    case "manus":
      return manus;
  }
}
