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
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
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

  // Web search on OpenAI runs through the Responses API with the web_search tool;
  // the other compat providers have no search capability.
  async function responsesWithSearch(req: ChatRequest, toolType = "web_search"): Promise<ChatResult> {
    if (!apiKey) throw new AdapterHttpError(401, `${cfg.keyEnv} is not set`);
    const body: Record<string, unknown> = {
      model: req.model,
      tools: [{ type: toolType }],
      instructions: req.system,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: req.maxTokens ?? 6000,
    };
    if (req.jsonSchema) {
      body.text = { format: { type: "json_schema", name: "result", strict: true, schema: req.jsonSchema } };
    }
    const res = await fetch(`${cfg.baseUrl}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      incomplete_details?: { reason?: string };
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      // older accounts may only know the preview tool name
      if (res.status === 400 && toolType === "web_search" && /web_search/.test(json.error?.message ?? "")) {
        return responsesWithSearch(req, "web_search_preview");
      }
      throw new AdapterHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`, json.error?.code);
    }
    if (json.status === "incomplete") {
      throw new Error(
        `${provider} response incomplete (${json.incomplete_details?.reason ?? "unknown"}) — raise maxTokens for this task (model=${req.model})`,
      );
    }
    const text = (json.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("");
    const searches = (json.output ?? []).filter((o) => o.type === "web_search_call").length;
    const usage: Usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
      ...(searches ? { searches } : {}),
    };
    let parsed: unknown;
    if (req.jsonSchema) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${provider} returned non-JSON for a schema request (model=${req.model})`);
      }
    }
    return { text, parsed, usage };
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    if (req.webSearch) {
      if (provider !== "openai") {
        throw new Error(`${provider} adapter has no web-search capability — route search tasks to anthropic, openai, or brave`);
      }
      return responsesWithSearch(req);
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
    // Reasoning models can burn the whole budget invisibly — empty output is an error,
    // never a valid result (caught this live: empty X version, FR-6.12)
    if (!text.trim() && res.choices?.[0]?.finish_reason === "length") {
      throw new Error(
        `${provider} exhausted the output budget before any visible text (reasoning model) — raise maxTokens (model=${req.model})`,
      );
    }
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

  async function generateImage(req: {
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
  }) {
    if (!apiKey) throw new AdapterHttpError(401, `${cfg.keyEnv} is not set`);
    const res = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        size: req.size ?? "1536x1024",
        ...(req.quality ? { quality: req.quality } : {}),
        n: 1,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{ b64_json?: string }>;
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      throw new AdapterHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`, json.error?.code);
    }
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`${provider} image response carried no b64_json`);
    return { imageBase64: b64, mimeType: "image/png", usage: { images: 1 } };
  }

  return {
    id: provider,
    capabilities: provider === "openai" ? ["chat", "image", "search"] : ["chat"],
    chat,
    healthCheck,
    classifyError: classifyCompatError,
    ...(provider === "openai" ? { generateImage } : {}),
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
  // fetch/network failures are TypeError; anything else is a provider/parse problem
  if (e instanceof TypeError) return { status: "timeout" };
  return { status: "provider_error" };
}
