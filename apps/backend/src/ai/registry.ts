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
  { provider: "anthropic", model: "claude-sonnet-5", capability: "chat", inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  { provider: "anthropic", model: "claude-haiku-4-5", capability: "chat", inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  { provider: "openai", model: "gpt-image-1", capability: "image", perImageUsd: 0.04 },
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
  // voice / video / code_snippet: routing-ready, no route seeded (FR-6.15)
];
