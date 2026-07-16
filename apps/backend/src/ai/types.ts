import type { Capability, HealthStatus, ProviderId } from "@post-automate/shared";

// Normalized adapter surface (design §6.1, FR-15.1). One adapter per provider *family*.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  /** JSON schema for structured output; adapters map to the provider's native mechanism. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  webSearch?: boolean; // discovery/research routes
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  searches?: number;
  images?: number;
  seconds?: number;
}

export interface ChatResult {
  text: string;
  parsed?: unknown; // populated when jsonSchema was set and validated
  usage: Usage;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  size?: string; // e.g. "1536x1024" (hero landscape)
  quality?: string; // provider-specific, e.g. gpt-image-1: low | medium | high
}

export interface ImageResult {
  imageBase64: string;
  mimeType: string;
  usage: Usage;
}

export interface HealthResult {
  status: HealthStatus;
  latencyMs: number;
  /** Human-readable, stored verbatim (FR-15.5) — see errorMessage() in health.ts */
  message: string;
}

export interface SearchRequest {
  query: string;
  count?: number;
  freshness?: "day" | "week" | "month";
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  results: SearchResultItem[];
  usage: Usage;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: Capability[];
  chat?(req: ChatRequest): Promise<ChatResult>; // absent on search-only providers (Brave)
  generateImage?(req: ImageRequest): Promise<ImageResult>;
  /** Raw web search (Brave) — feeds discovery/research as a two-step alternative to LLM-native search. */
  search?(req: SearchRequest): Promise<SearchResult>;
  healthCheck(model: string): Promise<HealthResult>;
  /** Map a thrown error to a health status — drives the router's fallback + health records (FR-15.6). */
  classifyError?(e: unknown): { status: HealthStatus; code?: number };
}
