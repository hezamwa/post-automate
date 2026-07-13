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
  size?: string;
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

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: Capability[];
  chat(req: ChatRequest): Promise<ChatResult>;
  generateImage?(req: ImageRequest): Promise<ImageResult>;
  healthCheck(model: string): Promise<HealthResult>;
}
