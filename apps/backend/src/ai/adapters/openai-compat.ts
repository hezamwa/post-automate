import type { ProviderId } from "@post-automate/shared";
import type { ProviderAdapter } from "../types";

// One adapter, four providers (design §6.1): OpenAI, DeepSeek, Moonshot (Kimi), Qwen
// (DashScope) — all expose OpenAI-compatible chat APIs; only baseURL + key differ.
// JSON-mode support varies by provider: where absent, fall back to prompt-enforced JSON
// + Zod validation with one retry (design §13).
// TODO(phase-1): implement; OpenAI also carries the image capability (gpt-image-1).

const BASE_URLS: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.ai/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

export function openAiCompat(provider: ProviderId): ProviderAdapter {
  return {
    id: provider,
    capabilities: provider === "openai" ? ["chat", "image"] : ["chat"],
    async chat() {
      throw new Error(`${provider} adapter not implemented yet (baseURL ${BASE_URLS[provider]})`);
    },
    async healthCheck() {
      throw new Error(`${provider} adapter not implemented yet`);
    },
  };
}
