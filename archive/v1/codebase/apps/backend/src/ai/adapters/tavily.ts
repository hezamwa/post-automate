import type { HealthStatus } from "@post-automate/shared";
import type { Env } from "../../shared/env";
import type { ExtractRequest, ExtractResult, HealthResult, ProviderAdapter, SearchRequest, SearchResult } from "../types";
import { AdapterHttpError } from "./openai-compat";

// Tavily adapter — SEARCH capability only, no chat. This is the provider behind the
// two-step discovery path (FR-5.4/5.8): tavily.search(query) → results injected into the
// brief → LLM synthesis by the task's chat route. Billed per search, so every call records
// {searches: 1} and the registry needs a per-search price before a route may point here.
// API: POST https://api.tavily.com/search, bearer auth.

const BASE_URL = "https://api.tavily.com";

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string; raw_content?: string; published_date?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
  detail?: { error?: string } | string;
  error?: string;
}

/** Tavily reports failures as {detail:{error}}, {detail:"..."} or {error:"..."} by endpoint. */
function tavilyMessage(body: TavilyResponse, status: number): string {
  if (typeof body.detail === "string" && body.detail.trim()) return body.detail;
  if (body.detail && typeof body.detail === "object" && body.detail.error) return body.detail.error;
  if (body.error) return body.error;
  return `HTTP ${status}`;
}

export function createTavilyAdapter(env: Env): ProviderAdapter {
  const apiKey = env.TAVILY_API_KEY;

  async function post(path: string, body: Record<string, unknown>): Promise<TavilyResponse> {
    if (!apiKey) throw new AdapterHttpError(401, "TAVILY_API_KEY is not set");
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as TavilyResponse;
    if (!res.ok) throw new AdapterHttpError(res.status, tavilyMessage(json, res.status));
    return json;
  }

  async function search(req: SearchRequest): Promise<SearchResult> {
    // A freshness window switches this to the news topic rather than passing time_range on
    // the default general topic. Verified live 2026-09-18: general+time_range returned job
    // ads and a Windows 10 post for "latest AI developer tooling releases", while the news
    // topic returned four on-topic articles from the past week — and only the news topic
    // reports published_date, which is what discovery scores recency on.
    // "advanced" depth costs more credits and did not beat this, so the cheap depth stands.
    const window = req.freshness ? { day: 1, week: 7, month: 30 }[req.freshness] : undefined;
    const json = await post("/search", {
      query: req.query,
      max_results: req.count ?? 8,
      search_depth: "basic",
      ...(window ? { topic: "news", days: window } : {}),
    });
    return {
      results: (json.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        ...(r.published_date ? { publishedDate: r.published_date } : {}),
      })),
      // One API call = one billed search regardless of how many results come back.
      usage: { searches: 1 },
    };
  }

  /**
   * Full page content (article-workflow §3 step 4). Tavily bills extract per 5 urls, so
   * usage counts one "search" per started block of five — the registry's per-search price
   * is the unit. Pages Tavily could not fetch are simply absent from the result.
   */
  async function extract(req: ExtractRequest): Promise<ExtractResult> {
    const json = await post("/extract", { urls: req.urls });
    return {
      pages: (json.results ?? [])
        .filter((r) => r.url && (r.raw_content ?? r.content))
        .map((r) => ({ url: r.url!, ...(r.title ? { title: r.title } : {}), content: r.raw_content ?? r.content ?? "" })),
      usage: { searches: Math.max(1, Math.ceil(req.urls.length / 5)) },
    };
  }

  async function healthCheck(model: string): Promise<HealthResult> {
    const started = Date.now();
    try {
      // Tavily publishes no free metadata endpoint, so the canary is a real (billed) search
      // kept as small as possible. Named in the message so the cost is not a surprise.
      await post("/search", { query: "ping", max_results: 1, search_depth: "basic" });
      return {
        status: "ok",
        latencyMs: Date.now() - started,
        message: `OK — ${model} responded (one billed search).`,
      };
    } catch (e) {
      const { status, code } = classifyTavilyError(e);
      return {
        status,
        latencyMs: Date.now() - started,
        message: `${status}${code ? ` (HTTP ${code})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
      };
    }
  }

  return { id: "tavily", capabilities: ["search"], search, extract, healthCheck, classifyError: classifyTavilyError };
}

export function classifyTavilyError(e: unknown): { status: HealthStatus; code?: number } {
  if (e instanceof AdapterHttpError) {
    const code = e.httpStatus;
    if (code === 401) return { status: "auth_error", code };
    // 432/433 are Tavily's plan-limit codes; 429 is ordinary rate limiting.
    if (code === 432 || code === 433) return { status: "quota", code };
    if (code === 429) return { status: "rate_limited", code };
    if (code >= 500) return { status: "provider_error", code };
    return { status: "provider_error", code };
  }
  if (e instanceof TypeError) return { status: "timeout" };
  return { status: "provider_error" };
}
