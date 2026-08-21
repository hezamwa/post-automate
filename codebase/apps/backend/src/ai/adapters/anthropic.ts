import Anthropic from "@anthropic-ai/sdk";
import type { HealthStatus } from "@post-automate/shared";
import type { Env } from "../../shared/env";
import type {
  ChatRequest,
  ChatResult,
  HealthResult,
  ProviderAdapter,
  Usage,
} from "../types";

// Anthropic adapter (design §6.1): official TS SDK. Structured outputs via
// output_config.format; web search via the server-side web_search tool.
// baseURL flips to Cloudflare AI Gateway when AI_GATEWAY_ANTHROPIC_BASE_URL is set.

const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search" };
const MAX_PAUSE_RESUMES = 3;

export function createAnthropicAdapter(env: Env): ProviderAdapter {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.AI_GATEWAY_ANTHROPIC_BASE_URL || undefined,
  });

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.system) params.system = req.system;
    if (req.jsonSchema) {
      params.output_config = { format: { type: "json_schema", schema: req.jsonSchema } };
    }
    if (req.webSearch) params.tools = [WEB_SEARCH_TOOL];

    let response = await client.messages.create(params as never);
    const usage: Usage = {};
    accumulateUsage(usage, response);

    // Server-side tool loops (web search) can pause; re-send to resume (bounded).
    for (let i = 0; response.stop_reason === "pause_turn" && i < MAX_PAUSE_RESUMES; i++) {
      params.messages = [
        ...(params.messages as unknown[]),
        { role: "assistant", content: response.content },
      ];
      response = await client.messages.create(params as never);
      accumulateUsage(usage, response);
    }

    if (response.stop_reason === "refusal") {
      throw new Error(`Anthropic refused the request (stop_reason=refusal, model=${req.model})`);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed: unknown;
    if (req.jsonSchema) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `Anthropic returned non-JSON despite output_config.format (model=${req.model}, stop_reason=${response.stop_reason})`,
        );
      }
    }
    return { text, parsed, usage };
  }

  async function healthCheck(model: string): Promise<HealthResult> {
    const started = Date.now();
    try {
      await client.messages.create({
        model,
        max_tokens: 16,
        // canary stays cheap: no thinking spend where the model would default to it
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "ping" }],
      } as never);
      return { status: "ok", latencyMs: Date.now() - started, message: "OK — model responded." };
    } catch (e) {
      const { status, code } = classifyError(e);
      return {
        status,
        latencyMs: Date.now() - started,
        message: `${status}${code ? ` (HTTP ${code})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
      };
    }
  }

  return { id: "anthropic", capabilities: ["chat", "search"], chat, healthCheck, classifyError };
}

function accumulateUsage(usage: Usage, response: Anthropic.Message): void {
  usage.inputTokens = (usage.inputTokens ?? 0) + response.usage.input_tokens;
  usage.outputTokens = (usage.outputTokens ?? 0) + response.usage.output_tokens;
  const searches = (response.usage as { server_tool_use?: { web_search_requests?: number } })
    .server_tool_use?.web_search_requests;
  if (searches) usage.searches = (usage.searches ?? 0) + searches;
}

export function classifyError(e: unknown): { status: HealthStatus; code?: number } {
  if (e instanceof Anthropic.APIError) {
    const code = typeof e.status === "number" ? e.status : undefined;
    if (code === 401 || code === 403) return { status: "auth_error", code };
    if (code === 404) return { status: "model_not_found", code };
    if (code === 429) return { status: "rate_limited", code };
    // Anthropic reports an empty credit balance as a 400 — surface it as quota,
    // not a generic provider error ("purchase credits", FR-15.5)
    if (code === 400 && e.message.includes("credit balance")) return { status: "quota", code };
    if (code && code >= 500) return { status: "provider_error", code };
    return { status: "provider_error", code };
  }
  return { status: "timeout" };
}
