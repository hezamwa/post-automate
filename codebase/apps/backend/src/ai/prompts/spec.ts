import type { ChatMessage, ChatRequest } from "../types";

// What a prompt builder returns (spec §2 "prompts"): a pure description of one chat call.
// System blocks are ordered stable-first so a cache breakpoint after the stable prefix
// is meaningful (design §6 "Prompt composition"); the router turns this into a request.

export interface PromptSpec {
  /** The builder's PROMPT_VERSION — recorded in generationMeta (FR-8.2). */
  version: string;
  /** Stable-first system blocks; empty strings are dropped. */
  system: string[];
  messages: ChatMessage[];
  /** Index of the last STABLE system block — the cache_control breakpoint goes after it. */
  cacheBreakpointAfter?: number;
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
}

/** Flatten a spec into the router's request shape. */
export function toChatRequest(spec: PromptSpec, extra: { webSearch?: boolean } = {}): Omit<ChatRequest, "model"> {
  return {
    system: spec.system.filter(Boolean).join("\n\n"),
    messages: spec.messages,
    ...(spec.jsonSchema ? { jsonSchema: spec.jsonSchema } : {}),
    maxTokens: spec.maxTokens,
    ...extra,
  };
}
