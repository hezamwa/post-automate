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
  /** The route's model. Tavily exposes one search surface and ignores it; Gemini grounding
   *  needs to know which model to ground. */
  model?: string;
  query: string;
  count?: number;
  freshness?: "day" | "week" | "month";
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** When the source published it, when the provider reports it — discovery scores on recency. */
  publishedDate?: string;
}

export interface SearchResult {
  results: SearchResultItem[];
  usage: Usage;
}

/** A model as the provider's own catalogue reports it (FR-15.4 registry assist). */
export interface ProviderModel {
  id: string;
  displayName?: string;
  /** null when the provider says nothing and the id gives no clue. */
  capability: Capability | null;
  /** true = inferred from the model id, not stated by the provider. Shown as such. */
  guessed: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: Capability[];
  chat?(req: ChatRequest): Promise<ChatResult>; // absent on search-only providers (Brave)
  generateImage?(req: ImageRequest): Promise<ImageResult>;
  /** Raw web search (Brave) — feeds discovery/research as a two-step alternative to LLM-native search. */
  search?(req: SearchRequest): Promise<SearchResult>;
  /** capability: what the model is, so the canary picks a matching probe (FR-15.5). Defaults to chat. */
  healthCheck(model: string, capability?: Capability): Promise<HealthResult>;
  /** The provider's live model catalogue; absent when it publishes no listing endpoint. */
  listModels?(): Promise<ProviderModel[]>;
  /** Map a thrown error to a health status — drives the router's fallback + health records (FR-15.6). */
  classifyError?(e: unknown): { status: HealthStatus; code?: number };
}
