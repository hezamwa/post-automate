// AI provider layer — shared vocabulary (FR-15.1/15.2, design §6.1)

export const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "moonshot",
  "deepseek",
  "qwen",
  "grok", // xAI — OpenAI-compatible API
  "manus", // agent platform — adapter shape verified at implementation (design §13)
  "brave", // Brave Search — search capability only
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const CAPABILITIES = ["chat", "image", "tts", "video", "search"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// Task-type registry (FR-15.2). Routing config maps each of these to a provider route;
// voice/video/code_snippet are routing-ready only in v1 (FR-6.15).
export const TASK_TYPES = [
  "interview",
  "discovery",
  "research", // targeted research for user-requested topics (FR-5.8)
  "scoring",
  "angles",
  "article",
  "shorten_x",
  "shorten_linkedin",
  "translate",
  "image",
  "voice",
  "video",
  "code_snippet",
  "refine",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_CAPABILITY: Record<TaskType, Capability> = {
  interview: "chat",
  discovery: "search",
  research: "search",
  scoring: "chat",
  angles: "chat",
  article: "chat",
  shorten_x: "chat",
  shorten_linkedin: "chat",
  translate: "chat",
  image: "image",
  voice: "tts",
  video: "video",
  code_snippet: "chat",
  refine: "chat",
};

export type HealthStatus =
  | "ok"
  | "auth_error"
  | "quota"
  | "rate_limited"
  | "model_not_found"
  | "timeout"
  | "provider_error";
