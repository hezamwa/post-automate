import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../shared/env";
import { createTavilyAdapter } from "./tavily";

// Tavily is billed per search, so what it reports as usage is what lands in spend_ledger.
const env = { TAVILY_API_KEY: "test-key" } as Env;

function stub(handler: (init?: RequestInit) => Response) {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : {});
    return handler(init);
  }) as typeof fetch);
  return calls;
}

const results = {
  results: [
    { title: "A", url: "https://a.example", content: "snippet a" },
    { title: "B", url: "https://b.example", content: "snippet b" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("tavily search", () => {
  it("normalises results to the adapter shape", async () => {
    stub(() => new Response(JSON.stringify(results), { status: 200 }));
    const out = await createTavilyAdapter(env).search!({ query: "what's new" });
    expect(out.results).toEqual([
      { title: "A", url: "https://a.example", snippet: "snippet a" },
      { title: "B", url: "https://b.example", snippet: "snippet b" },
    ]);
  });

  it("bills one search per call, not one per result", async () => {
    // The unit priced in the registry is the API call; counting results would multiply the
    // recorded cost by however many links came back.
    stub(() => new Response(JSON.stringify(results), { status: 200 }));
    const out = await createTavilyAdapter(env).search!({ query: "x" });
    expect(out.results).toHaveLength(2);
    expect(out.usage).toEqual({ searches: 1 });
  });

  it("uses the news topic for a freshness window, not time_range", async () => {
    // Verified live: general topic + time_range returned stale, off-topic pages, while the
    // news topic returned recent on-topic articles AND published dates. Pinned here so the
    // parameter choice cannot be "tidied" back to time_range without a failing test.
    const calls = stub(() => new Response(JSON.stringify(results), { status: 200 }));
    await createTavilyAdapter(env).search!({ query: "x", count: 3, freshness: "day" });
    expect(calls[0]).toMatchObject({ query: "x", max_results: 3, topic: "news", days: 1, search_depth: "basic" });
    expect(calls[0]).not.toHaveProperty("time_range");
  });

  it("maps each freshness window to its day count", async () => {
    for (const [freshness, days] of [["day", 1], ["week", 7], ["month", 30]] as const) {
      const calls = stub(() => new Response(JSON.stringify(results), { status: 200 }));
      await createTavilyAdapter(env).search!({ query: "x", freshness });
      expect(calls[0]).toMatchObject({ topic: "news", days });
      vi.unstubAllGlobals();
    }
  });

  it("stays on the general topic when no freshness is asked for", async () => {
    const calls = stub(() => new Response(JSON.stringify(results), { status: 200 }));
    await createTavilyAdapter(env).search!({ query: "x" });
    expect(calls[0]).not.toHaveProperty("topic");
    expect(calls[0]).not.toHaveProperty("days");
  });

  it("carries the publication date through when the provider reports one", async () => {
    stub(() =>
      new Response(
        JSON.stringify({ results: [{ title: "A", url: "https://a.example", content: "s", published_date: "Tue, 16 Sep 2026 11:56:16 GMT" }] }),
        { status: 200 },
      ));
    const out = await createTavilyAdapter(env).search!({ query: "x", freshness: "week" });
    expect(out.results[0]!.publishedDate).toBe("Tue, 16 Sep 2026 11:56:16 GMT");
  });

  it("has no chat capability, so chat tasks can never dispatch to it", () => {
    const adapter = createTavilyAdapter(env);
    expect(adapter.chat).toBeUndefined();
    expect(adapter.capabilities).toEqual(["search"]);
  });
});

describe("tavily healthCheck", () => {
  it("reports ok and says the canary costs a search", async () => {
    stub(() => new Response(JSON.stringify(results), { status: 200 }));
    const r = await createTavilyAdapter(env).healthCheck("tavily-search");
    expect(r.status).toBe("ok");
    expect(r.message).toMatch(/billed search/);
  });

  it("maps plan limits to quota and bad keys to auth_error", async () => {
    for (const [code, expected] of [[401, "auth_error"], [432, "quota"], [433, "quota"], [429, "rate_limited"], [500, "provider_error"]] as const) {
      stub(() => new Response(JSON.stringify({ detail: { error: "nope" } }), { status: code }));
      expect((await createTavilyAdapter(env).healthCheck("tavily-search")).status).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it("reads Tavily's error whichever shape it arrives in", async () => {
    stub(() => new Response(JSON.stringify({ detail: "usage limit exceeded" }), { status: 432 }));
    expect((await createTavilyAdapter(env).healthCheck("tavily-search")).message).toMatch(/usage limit exceeded/);
  });

  it("fails as auth_error without calling out when the key is missing", async () => {
    const calls = stub(() => new Response("{}", { status: 200 }));
    expect((await createTavilyAdapter({} as Env).healthCheck("tavily-search")).status).toBe("auth_error");
    expect(calls).toHaveLength(0);
  });
});
