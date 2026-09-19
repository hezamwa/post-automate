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
  "tavily", // Tavily — web search built for agents; search capability only
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
  // Two-step web search (FR-5.4/5.8): configure a route here and discovery/research fetch
  // real results first and hand them to the chat model, instead of relying on the model's
  // own search. No route configured = the LLM-native path, unchanged.
  "web_search",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

// What the router will actually CALL for each task — not what the task is "about".
// Corrected 2026-09-18: discovery/research were "search", but both run through
// router.runTask → adapter.chat using LLM-native web search; only the image task takes
// the runImageTask → adapter.generateImage path. The old values described intent, and
// since nothing read this constant the mismatch stayed invisible. It is now the rule the
// route picker and the /admin/ai/routes validator both enforce (see models.ts).
export const TASK_CAPABILITY: Record<TaskType, Capability> = {
  interview: "chat",
  discovery: "chat",
  research: "chat",
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
  web_search: "search",
};

// Tasks whose CHAT call may perform web search itself, billed per search (FR-5.4/5.8).
// Still required even with a web_search route configured: that route is optional, and when
// none exists these tasks fall back to the model's own search and are billed for it.
export const TASK_NEEDS_WEB_SEARCH: ReadonlySet<TaskType> = new Set<TaskType>(["discovery", "research"]);

export type HealthStatus =
  | "ok"
  | "auth_error"
  | "quota"
  | "rate_limited"
  | "model_not_found"
  | "timeout"
  | "provider_error";
