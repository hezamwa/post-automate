import type { HealthStatus, ProviderId } from "@post-automate/shared";
import type { Env } from "../../shared/env";
import type {
  ChatRequest,
  ChatResult,
  HealthResult,
  ProviderAdapter,
  Usage,
} from "../types";

// One adapter, five providers (design §6.1): OpenAI, DeepSeek, Moonshot (Kimi),
// Qwen (DashScope), xAI Grok — all expose OpenAI-compatible chat APIs; only
// baseURL + key differ. Raw fetch (Workers-native), no SDK needed.
//
// Structured output: OpenAI gets native response_format json_schema (strict);
// the others get prompt-enforced JSON + validation (design §13) since their
// json_schema support varies.
// Web search: not supported here (Anthropic's server tool or Brave covers it).

const CONFIG = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY" },
  qwen: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyEnv: "QWEN_API_KEY" },
  grok: { baseUrl: "https://api.x.ai/v1", keyEnv: "GROK_API_KEY" },
} as const;

type CompatProvider = keyof typeof CONFIG;

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

export function openAiCompat(provider: ProviderId, env: Env): ProviderAdapter {
  const cfg = CONFIG[provider as CompatProvider];
  if (!cfg) throw new Error(`openAiCompat does not serve provider '${provider}'`);
  const apiKey = env[cfg.keyEnv as keyof Env] as string | undefined;

  async function complete(body: Record<string, unknown>): Promise<CompletionResponse> {
    if (!apiKey) throw new AdapterHttpError(401, `${cfg.keyEnv} is not set`);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as CompletionResponse;
    if (!res.ok) {
      throw new AdapterHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`, json.error?.code);
    }
    return json;
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    if (req.webSearch) {
      throw new Error(`${provider} adapter has no web-search capability — route search tasks to anthropic or brave`);
    }
    const messages: Array<{ role: string; content: string }> = [];
    let system = req.system ?? "";
    const nativeSchema = provider === "openai" && !!req.jsonSchema;
    if (req.jsonSchema && !nativeSchema) {
      system += `\n\nRespond ONLY with a single JSON object matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(req.jsonSchema)}`;
    }
    if (system) messages.push({ role: "system", content: system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    const body: Record<string, unknown> = { model: req.model, messages };
    // OpenAI deprecated max_tokens in favor of max_completion_tokens; the compat
    // providers still expect max_tokens.
    body[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = req.maxTokens ?? 4096;
    if (nativeSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: req.jsonSchema },
      };
    }

    const res = await complete(body);
    const text = res.choices?.[0]?.message?.content ?? "";
    const usage: Usage = {
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    };

    let parsed: unknown;
    if (req.jsonSchema) {
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        throw new Error(`${provider} returned non-JSON for a schema request (model=${req.model})`);
      }
    }
    return { text, parsed, usage };
  }

  async function healthCheck(model: string): Promise<HealthResult> {
    const started = Date.now();
    try {
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: "ping" }],
      };
      body[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = 16;
      await complete(body);
      return { status: "ok", latencyMs: Date.now() - started, message: "OK — model responded." };
    } catch (e) {
      const { status, code } = classifyCompatError(e);
      return {
        status,
        latencyMs: Date.now() - started,
        message: `${status}${code ? ` (HTTP ${code})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
      };
    }
  }

  return {
    id: provider,
    capabilities: provider === "openai" ? ["chat", "image"] : ["chat"],
    chat,
    healthCheck,
    classifyError: classifyCompatError,
  };
}

export class AdapterHttpError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
    public providerCode?: string,
  ) {
    super(message);
  }
}

export function classifyCompatError(e: unknown): { status: HealthStatus; code?: number } {
  if (e instanceof AdapterHttpError) {
    const code = e.httpStatus;
    if (code === 401 || code === 403) return { status: "auth_error", code };
    if (code === 404) return { status: "model_not_found", code };
    if (code === 429) {
      // OpenAI signals an exhausted balance as 429 insufficient_quota
      return { status: e.providerCode === "insufficient_quota" ? "quota" : "rate_limited", code };
    }
    if (code >= 500) return { status: "provider_error", code };
    // some providers 400 on unknown models
    if (code === 400 && /model/i.test(e.message)) return { status: "model_not_found", code };
    return { status: "provider_error", code };
  }
  return { status: "timeout" };
}
