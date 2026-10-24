import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../shared/env";
import { createGoogleAdapter } from "./google";

// Gemini adapter (design §6.1) against a stubbed Generative Language API: the request shape
// it builds, the usage it reports (metering depends on it, FR-15.7) and how provider errors
// map to health statuses (the router's fallback reads those, FR-15.6).

const env = { GOOGLE_AI_API_KEY: "test-key" } as Env;

function stubGemini(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return handler(String(url), init);
  }) as typeof fetch);
  return calls;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, message: string, statusText?: string) =>
  new Response(JSON.stringify({ error: { message, status: statusText } }), { status });

const textReply = {
  candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
};

afterEach(() => vi.unstubAllGlobals());

describe("google chat", () => {
  it("maps the assistant role to 'model' and sends the system prompt separately", async () => {
    const calls = stubGemini(() => ok(textReply));
    await createGoogleAdapter(env).chat!({
      model: "gemini-test",
      system: "be terse",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    });

    expect(calls[0]!.url).toContain("/models/gemini-test:generateContent");
    expect(calls[0]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] }, // Gemini has no "assistant"
      { role: "user", parts: [{ text: "again" }] },
    ]);
    expect(calls[0]!.body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
  });

  it("reports token usage so the call can be priced", async () => {
    stubGemini(() => ok(textReply));
    const result = await createGoogleAdapter(env).chat!({ model: "gemini-test", messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("pong");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("counts grounded searches, which is what per-search pricing bills", async () => {
    const calls = stubGemini(() =>
      ok({
        candidates: [
          {
            content: { parts: [{ text: "found" }] },
            finishReason: "STOP",
            groundingMetadata: { webSearchQueries: ["a", "b"] },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      }),
    );
    const result = await createGoogleAdapter(env).chat!({
      model: "gemini-test",
      messages: [{ role: "user", content: "what's new" }],
      webSearch: true,
    });
    expect(calls[0]!.body.tools).toEqual([{ google_search: {} }]);
    expect(result.usage.searches).toBe(2);
  });

  it("asks for JSON and parses it when a schema is requested", async () => {
    const calls = stubGemini(() =>
      ok({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }] }),
    );
    const result = await createGoogleAdapter(env).chat!({
      model: "gemini-test",
      messages: [{ role: "user", content: "json please" }],
      jsonSchema: { type: "object" },
    });
    expect((calls[0]!.body.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
    expect(result.parsed).toEqual({ ok: true });
  });

  it("names the finish reason instead of returning an empty string", async () => {
    stubGemini(() => ok({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }));
    await expect(
      createGoogleAdapter(env).chat!({ model: "gemini-test", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/finishReason=SAFETY/);
  });
});

describe("google search (grounding as a search provider)", () => {
  const grounded = {
    candidates: [
      {
        content: { parts: [{ text: "Two things shipped this week." }] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["ai tooling releases"],
          groundingChunks: [
            { web: { uri: "https://one.example", title: "First" } },
            { web: { uri: "https://two.example", title: "Second" } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 120 },
  };

  it("takes its source list from grounding chunks, not the prose", async () => {
    // The chunks are the URLs the model actually retrieved; parsing links out of the answer
    // text would happily pick up anything it invented.
    stubGemini(() => ok(grounded));
    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "what shipped" });
    expect(out.results.map((r) => r.url)).toEqual(["https://one.example", "https://two.example"]);
    expect(out.results[0]!.title).toBe("First");
  });

  it("ignores the URLs the model reports, which are fabricated", async () => {
    // Verified live 2026-09-18: asked for its sources, the model returned 4 plausible URLs
    // out of 5 that 404 — including an invented blog.google path for a real Google post.
    // Only groundingChunks reflect what it actually retrieved, and FR-5.4 requires a real
    // source URL. The model's text is used for the headline, never for the link.
    stubGemini(() =>
      ok({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ results: [{ title: "Real Headline", url: "https://one.example/made-up-path", snippet: "a summary", publishedDate: "2026-09-15" }] }) }],
            },
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["q"],
              groundingChunks: [{ web: { uri: "https://one.example/actual", title: "one.example" } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }));

    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "x" });
    expect(out.results).toHaveLength(1);
    // link from the chunk...
    expect(out.results[0]!.url).toBe("https://one.example/actual");
    expect(out.results[0]!.url).not.toContain("made-up-path");
    // ...headline and date from the model's item, matched to the chunk by host
    expect(out.results[0]!.title).toBe("Real Headline");
    expect(out.results[0]!.publishedDate).toBe("2026-09-15");
  });

  it("falls back to the chunk's domain when the model reported nothing for that host", async () => {
    stubGemini(() =>
      ok({
        candidates: [
          {
            content: { parts: [{ text: "not json at all" }] },
            finishReason: "STOP",
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://solo.example/a", title: "solo.example" } }] },
          },
        ],
      }));
    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "x" });
    expect(out.results[0]).toMatchObject({ url: "https://solo.example/a", title: "solo.example" });
  });

  it("grounds against Google Search and uses the route's model", async () => {
    const calls = stubGemini(() => ok(grounded));
    await createGoogleAdapter(env).search!({ model: "gemini-2.5-pro", query: "x" });
    expect(calls[0]!.url).toContain("/models/gemini-2.5-pro:generateContent");
    expect(calls[0]!.body.tools).toEqual([{ google_search: {} }]);
  });

  it("reports tokens AND searches, because grounding bills both", async () => {
    // Undercounting either one would make the budget gates lie (FR-15.7).
    stubGemini(() => ok(grounded));
    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "x" });
    expect(out.usage).toEqual({ inputTokens: 40, outputTokens: 120, searches: 1 });
  });

  it("asks for the freshness window and caps the result count", async () => {
    const calls = stubGemini(() => ok(grounded));
    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "x", count: 1, freshness: "week" });
    const prompt = (calls[0]!.body.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0]!.text;
    expect(prompt).toMatch(/within the last week/);
    expect(prompt).toMatch(/1 most relevant/);
    expect(out.results).toHaveLength(1);
  });

  it("returns nothing rather than guessing when the model grounded on nothing", async () => {
    stubGemini(() => ok({ candidates: [{ content: { parts: [{ text: "I found nothing." }] }, finishReason: "STOP" }] }));
    const out = await createGoogleAdapter(env).search!({ model: "gemini-test", query: "x" });
    expect(out.results).toEqual([]);
  });
});

describe("google healthCheck", () => {
  it("pings a chat model and reports latency", async () => {
    stubGemini(() => ok(textReply));
    const result = await createGoogleAdapter(env).healthCheck("gemini-test");
    expect(result.status).toBe("ok");
    expect(result.message).toBe("OK — model responded.");
  });

  it("probes a non-chat model with GET instead of a chat ping (FR-15.5)", async () => {
    const calls = stubGemini(() => ok({ name: "models/imagen-test" }));
    const result = await createGoogleAdapter(env).healthCheck("imagen-test", "image");
    expect(calls[0]!.url).toContain("/models/imagen-test");
    expect(calls[0]!.url).not.toContain(":generateContent");
    expect(result.status).toBe("ok");
  });

  it("maps provider errors to the statuses the router falls back on", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "bad key", "auth_error"],
      [404, "not found", "model_not_found"],
      [429, "slow down", "rate_limited"],
      [500, "boom", "provider_error"],
    ];
    for (const [code, message, expected] of cases) {
      stubGemini(() => err(code, message));
      expect((await createGoogleAdapter(env).healthCheck("gemini-test")).status).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it("separates an exhausted quota from a rate limit", async () => {
    stubGemini(() => err(429, "quota exceeded", "QUOTA_EXCEEDED"));
    expect((await createGoogleAdapter(env).healthCheck("gemini-test")).status).toBe("quota");
  });

  it("fails as auth_error when the key is missing rather than calling out", async () => {
    const calls = stubGemini(() => ok(textReply));
    const result = await createGoogleAdapter({} as Env).healthCheck("gemini-test");
    expect(result.status).toBe("auth_error");
    expect(calls).toHaveLength(0);
  });
});
