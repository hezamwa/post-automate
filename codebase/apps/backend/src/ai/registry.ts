import type { ProviderId, TaskType } from "@post-automate/shared";

// The model registry is a TABLE now (ai_models, migration 0010), not a constant: an admin
// adds a provider's model and its prices from the dashboard, no deploy (FR-15.4, mirroring
// FR-15.3's "routing config is data"). Read it with listModels(db); the rule deciding what
// may serve which task is pure and lives in @post-automate/shared.

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
  { taskType: "outline", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "quality_check", provider: "anthropic", model: "claude-haiku-4-5" },
  { taskType: "image_concepts", provider: "anthropic", model: "claude-haiku-4-5" },
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
  { taskType: "outline", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "quality_check", provider: "openai", model: "gpt-5-mini", priority: 1 },
  { taskType: "image_concepts", provider: "openai", model: "gpt-5-mini", priority: 1 },
  // voice / video / code_snippet: routing-ready, no route seeded (FR-6.15)
];
