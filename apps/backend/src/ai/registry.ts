import type { Capability, ProviderId, TaskType } from "@post-automate/shared";

// Model registry: allowed models + unit prices for validation and cost computation (FR-15.4).
// Prices are estimates — verify against current provider pricing when wiring meter.ts.

export interface ModelInfo {
  provider: ProviderId;
  model: string;
  capability: Capability;
  inputPerMTokUsd?: number;
  outputPerMTokUsd?: number;
  perImageUsd?: number;
  perSearchUsd?: number;
}

export const MODEL_REGISTRY: ModelInfo[] = [
  { provider: "anthropic", model: "claude-sonnet-5", capability: "chat", inputPerMTokUsd: 3, outputPerMTokUsd: 15, perSearchUsd: 0.01 },
  { provider: "anthropic", model: "claude-haiku-4-5", capability: "chat", inputPerMTokUsd: 1, outputPerMTokUsd: 5, perSearchUsd: 0.01 },
  { provider: "openai", model: "gpt-image-1", capability: "image", perImageUsd: 0.04 },
  // Verified live 2026-07-16 via /v1/models; prices are estimates — confirm before heavy use
  { provider: "openai", model: "gpt-4.1-mini", capability: "chat", inputPerMTokUsd: 0.4, outputPerMTokUsd: 1.6, perSearchUsd: 0.01 },
  { provider: "openai", model: "gpt-5-mini", capability: "chat", inputPerMTokUsd: 0.25, outputPerMTokUsd: 2, perSearchUsd: 0.01 },
  // Prices unset = verify current provider pricing before routing to it (meter.ts refuses unpriced models).
  { provider: "grok", model: "grok-4", capability: "chat" },
  { provider: "brave", model: "brave-web-search", capability: "search", perSearchUsd: 0.005 },
  // Add OpenAI/Gemini/Moonshot/DeepSeek/Qwen chat models as routes need them (FR-15.1).
  // Manus: agent-platform API — add once the adapter's capability mapping is verified (design §13).
];

// Seed data for ai_routes (design §6.4) — inserted by tools/seed.ts, NOT read at runtime.
// Runtime routing always resolves from the ai_routes table (FR-15.3).
export const DEFAULT_ROUTES: ReadonlyArray<{
  taskType: TaskType;
  provider: ProviderId;
  model: string;
  priority?: number; // 0 = primary (default); 1+ = fallbacks (FR-15.6)
}> = [
  { taskType: "interview", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "discovery", provider: "anthropic", model: "claude-sonnet-5" },
  { taskType: "research", provider: "anthropic", model: "claude-sonnet-5" },
  { taskType: "scoring", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "angles", provider: "anthropic", model: "claude-sonnet-5" },
  { taskType: "article", provider: "anthropic", model: "claude-sonnet-5" },
  { taskType: "shorten_x", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "shorten_linkedin", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "translate", provider: "anthropic", model: "claude-sonnet-5" },
  { taskType: "image", provider: "openai", model: "gpt-image-1" },
  // OpenAI fallbacks (verified live 2026-07-16) — used automatically on
  // anthropic auth/quota/rate-limit/5xx failures (FR-15.6). Discovery/research
  // fall back to OpenAI's Responses API web_search tool.
  { taskType: "discovery", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "research", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "interview", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "scoring", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "angles", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "article", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "shorten_x", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "shorten_linkedin", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "translate", provider: "openai", model: "gpt-5-mini", priority: 1 },
  // voice / video / code_snippet: routing-ready, no route seeded (FR-6.15)
];
