import type { Capability, HealthStatus } from "@post-automate/shared";
import type { Env } from "../../shared/env";
import type {
  ChatRequest,
  ChatResult,
  HealthResult,
  ProviderAdapter,
  ProviderModel,
  SearchRequest,
  SearchResult,
  Usage,
} from "../types";
import { AdapterHttpError } from "./openai-compat";

// Google Gemini adapter (design §6.1). Raw fetch against the Generative Language API —
// Workers-native, no SDK. A factory like Anthropic's because it needs the key from env.
//
// Structured output: responseMimeType "application/json" forces valid JSON, and the result
// is parsed and handed back for the caller to validate — deliberately NOT responseSchema,
// which accepts only a subset of JSON Schema (design §13's "prompt-enforced JSON +
// validation" path for non-OpenAI providers).
//
// Web search: the google_search tool is wired for req.webSearch, and searches are counted
// from groundingMetadata so metering matches per-search pricing (FR-15.7). The tool is
// named google_search on Gemini 2.x and google_search_retrieval on 1.5 — a route to an
// older model gets a 400 naming the tool, which classifies as provider_error rather than
// failing silently.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string; code?: number };
}

export function createGoogleAdapter(env: Env): ProviderAdapter {
  const apiKey = env.GOOGLE_AI_API_KEY;

  async function call(model: string, body: Record<string, unknown>): Promise<GenerateContentResponse> {
    if (!apiKey) throw new AdapterHttpError(401, "GOOGLE_AI_API_KEY is not set");
    const res = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as GenerateContentResponse;
    if (!res.ok) {
      throw new AdapterHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`, json.error?.status);
    }
    return json;
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens ?? 4096 };
    if (req.jsonSchema) generationConfig.responseMimeType = "application/json";

    const body: Record<string, unknown> = {
      // Gemini calls the assistant role "model"
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig,
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.webSearch) body.tools = [{ google_search: {} }];

    const json = await call(req.model, body);
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    if (!text && candidate?.finishReason && candidate.finishReason !== "STOP") {
      // SAFETY / MAX_TOKENS / RECITATION all arrive as an empty candidate — say which,
      // rather than handing the caller a silent empty string.
      throw new Error(`Gemini returned no text (finishReason=${candidate.finishReason}, model=${req.model})`);
    }

    const usage: Usage = {
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    };
    const searches = candidate?.groundingMetadata?.webSearchQueries?.length;
    if (searches) usage.searches = searches;

    let parsed: unknown;
    if (req.jsonSchema) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `Gemini returned non-JSON despite responseMimeType=application/json (model=${req.model}, finishReason=${candidate?.finishReason ?? "none"})`,
        );
      }
    }
    return { text, parsed, usage };
  }

  /**
   * Google Search grounding presented as a search provider, so it can sit in the web_search
   * fallback chain behind a dedicated provider (FR-15.6).
   *
   * Grounding is a tool on a chat call, not a search endpoint: the model searches, then
   * answers. Rather than reverse-engineering per-result snippets out of groundingSupports
   * segment offsets, this asks for the findings as structured items directly — the model has
   * the sources in hand and returns them in the shape the brief needs.
   *
   * It therefore bills BOTH tokens and searches, which is why a Gemini row used for
   * web_search needs token prices as well as a per-search price; metering throws on either
   * being absent rather than undercounting (meter.ts).
   */
  async function search(req: SearchRequest): Promise<SearchResult> {
    const model = req.model ?? "gemini-2.5-flash";
    const want = req.count ?? 8;
    const window = req.freshness ? { day: "24 hours", week: "week", month: "month" }[req.freshness] : undefined;
    const instruction = [
      `Search the web and list the ${want} most relevant results for the query.`,
      window ? `Only include items published within the last ${window}.` : "",
      'Reply with JSON only, no prose and no code fences: {"results":[{"title":"…","url":"https://…","snippet":"one sentence","publishedDate":"YYYY-MM-DD"}]}',
    ]
      .filter(Boolean)
      .join(" ");

    const json = await call(model, {
      contents: [{ role: "user", parts: [{ text: `${instruction}\n\nQuery: ${req.query}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 4096 },
    });

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    // URLs come from groundingChunks and NOWHERE else. Verified live 2026-09-18: asked for
    // its sources directly, the model returns plausible-looking links that 404 — 4 of 5 in
    // one sample, including a fabricated blog.google path for a real Google announcement.
    // The chunks are what it actually retrieved, so they are the only trustworthy links, and
    // FR-5.4 requires candidates to cite a real source URL.
    //
    // The chunks arrive as vertexaisearch redirect URLs titled with a bare domain, so each
    // is resolved to the publisher's link, and the model's reported items supply the headline
    // and snippet — matched by host, which is the one part of its output that is verifiable.
    const reported = parseReportedResults(text);
    const byHost = new Map<string, (typeof reported)[number]>();
    for (const r of reported) {
      const host = hostOf(r.url);
      if (host && !byHost.has(host)) byHost.set(host, r);
    }

    const chunks = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web)
      .filter((w): w is { uri: string; title?: string } => !!w?.uri)
      .slice(0, want);

    const results = await Promise.all(
      chunks.map(async (w) => {
        const url = await resolveRedirect(w.uri);
        const host = hostOf(url);
        const match = host ? byHost.get(host) : undefined;
        return {
          title: match?.title ?? w.title ?? host ?? url,
          url,
          snippet: match?.snippet ?? text.slice(0, 300),
          ...(match?.publishedDate ? { publishedDate: match.publishedDate } : {}),
        };
      }),
    );

    const usage: Usage = {
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    };
    const searches = candidate?.groundingMetadata?.webSearchQueries?.length;
    if (searches) usage.searches = searches;

    return { results, usage };
  }

  async function healthCheck(model: string, capability: Capability = "chat"): Promise<HealthResult> {
    const started = Date.now();
    try {
      if (capability !== "chat") {
        // Same reasoning as the compat adapter: probing a non-chat model with a chat ping
        // reports "model not found" even when the route is fine. GET validates auth and
        // existence for free (FR-15.5).
        if (!apiKey) throw new AdapterHttpError(401, "GOOGLE_AI_API_KEY is not set");
        const res = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}`, {
          headers: { "x-goog-api-key": apiKey },
        });
        if (!res.ok) throw new AdapterHttpError(res.status, `GET /models/${model} → HTTP ${res.status}`);
        return { status: "ok", latencyMs: Date.now() - started, message: "OK — model responded." };
      }
      await call(model, {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 16 },
      });
      return { status: "ok", latencyMs: Date.now() - started, message: "OK — model responded." };
    } catch (e) {
      const { status, code } = classifyGoogleError(e);
      return {
        status,
        latencyMs: Date.now() - started,
        message: `${status}${code ? ` (HTTP ${code})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
      };
    }
  }

  async function listModels(): Promise<ProviderModel[]> {
    if (!apiKey) throw new AdapterHttpError(401, "GOOGLE_AI_API_KEY is not set");
    const res = await fetch(`${BASE_URL}/models?pageSize=200`, { headers: { "x-goog-api-key": apiKey } });
    const json = (await res.json().catch(() => ({}))) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      error?: { message?: string; status?: string };
    };
    if (!res.ok) throw new AdapterHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`, json.error?.status);
    return (json.models ?? [])
      .filter((m): m is { name: string; displayName?: string; supportedGenerationMethods?: string[] } => !!m.name)
      .map((m) => {
        const id = m.name.replace(/^models\//, "");
        const methods = m.supportedGenerationMethods ?? [];
        // generateContent is the chat surface. predictLongRunning is the image/video
        // generation surface, distinguished by family. Embedding-only models get null.
        let capability: ProviderModel["capability"] = null;
        if (methods.includes("generateContent") || methods.includes("bidiGenerateContent")) capability = "chat";
        else if (methods.includes("predictLongRunning")) capability = /veo/i.test(id) ? "video" : "image";
        return { id, displayName: m.displayName, capability, guessed: false };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    id: "google",
    capabilities: ["chat", "search"],
    chat,
    search,
    healthCheck,
    listModels,
    classifyError: classifyGoogleError,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * Follow a grounding redirect to the publisher's URL. Manual redirect: one hop, no body
 * downloaded. Anything unexpected keeps the redirect URL — opaque but genuine beats dropping
 * a source, and a redirect that cannot be resolved still resolves in a browser.
 */
async function resolveRedirect(uri: string): Promise<string> {
  if (!uri.includes("grounding-api-redirect")) return uri;
  try {
    const res = await fetch(uri, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
    return res.headers.get("location") ?? uri;
  } catch {
    return uri;
  }
}

/** Pull the model's JSON out of a grounded reply, tolerating code fences and stray prose. */
function parseReportedResults(text: string): Array<{ title: string; url: string; snippet: string; publishedDate?: string }> {
  const body = text.replace(/^[\s\S]*?\`\`\`(?:json)?/, "").replace(/\`\`\`[\s\S]*$/, "").trim() || text.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      results?: Array<{ title?: string; url?: string; snippet?: string; publishedDate?: string }>;
    };
    return (parsed.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: r.snippet ?? "",
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      }));
  } catch {
    return [];
  }
}

export function classifyGoogleError(e: unknown): { status: HealthStatus; code?: number } {
  if (e instanceof AdapterHttpError) {
    const code = e.httpStatus;
    if (code === 401 || code === 403) return { status: "auth_error", code };
    if (code === 404) return { status: "model_not_found", code };
    // Google signals both rate limits and an exhausted quota as 429; the status string
    // distinguishes them (RESOURCE_EXHAUSTED covers both, so fall back to rate_limited).
    if (code === 429) return { status: e.providerCode === "QUOTA_EXCEEDED" ? "quota" : "rate_limited", code };
    if (code >= 500) return { status: "provider_error", code };
    // 400 INVALID_ARGUMENT on an unknown model name
    if (code === 400 && /model/i.test(e.message)) return { status: "model_not_found", code };
    return { status: "provider_error", code };
  }
  if (e instanceof TypeError) return { status: "timeout" };
  return { status: "provider_error" };
}
