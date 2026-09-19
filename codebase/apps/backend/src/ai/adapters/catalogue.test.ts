import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../shared/env";
import { createGoogleAdapter } from "./google";
import { guessCapability, openAiCompat } from "./openai-compat";

// The live catalogue behind the Models tab. What matters is that a capability is never
// asserted more confidently than the provider supports it: OpenAI-family listings carry no
// capability at all (so everything is a guess from the id), Google states its generation
// methods, and a model we cannot place gets null rather than a wrong answer.

afterEach(() => vi.unstubAllGlobals());

describe("guessCapability", () => {
  it("recognises generation families from the id", () => {
    expect(guessCapability("gpt-image-1")).toBe("image");
    expect(guessCapability("dall-e-3")).toBe("image");
    expect(guessCapability("tts-1-hd")).toBe("tts");
    expect(guessCapability("sora-2")).toBe("video");
  });

  it("gives no capability to models nothing can route to", () => {
    // Real models, but no task type maps to them — null keeps them out of the picker
    // instead of mislabelling them as chat.
    expect(guessCapability("text-embedding-3-large")).toBeNull();
    expect(guessCapability("whisper-1")).toBeNull();
    expect(guessCapability("omni-moderation-latest")).toBeNull();
  });

  it("defaults to chat, which is what the bulk of a listing is", () => {
    expect(guessCapability("gpt-5-mini")).toBe("chat");
    expect(guessCapability("deepseek-chat")).toBe("chat");
    expect(guessCapability("kimi-k2")).toBe("chat");
  });

  it("does not read vision INPUT as image generation", () => {
    // Moonshot advertises supports_image_in on chat models; treating that as our "image"
    // capability would route image generation at a model that cannot generate images.
    expect(guessCapability("kimi-k2-vision")).toBe("chat");
  });
});

describe("openai-compat listModels", () => {
  it("flags every capability as guessed, because the listing states none", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }, { id: "gpt-image-1" }] }), { status: 200 })) as typeof fetch);

    const models = await openAiCompat("openai", { OPENAI_API_KEY: "k" } as Env).listModels!();
    expect(models).toEqual([
      { id: "gpt-5-mini", capability: "chat", guessed: true },
      { id: "gpt-image-1", capability: "image", guessed: true },
    ]);
  });

  it("surfaces a refusal whose error field is a bare string", async () => {
    // xAI's real 403 shape. "OpenAI-compatible" describes the request, not the error body:
    // reading only {error:{message}} turned "your team has no credits" into "HTTP 403",
    // which tells the admin nothing about what to fix.
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({ code: "permission-denied", error: "Your newly created team doesn't have any credits or licenses yet." }),
        { status: 403 },
      )) as typeof fetch);
    await expect(openAiCompat("grok", { GROK_API_KEY: "k" } as Env).listModels!()).rejects.toThrow(/credits or licenses/);
  });

  it("surfaces a provider refusal instead of an empty list", async () => {
    // This is grok today: the account has no credits, so the listing 403s. An empty table
    // would read as "no models"; the admin needs the provider's reason.
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ error: { message: "team has no credits" } }), { status: 403 })) as typeof fetch);
    await expect(openAiCompat("grok", { GROK_API_KEY: "k" } as Env).listModels!()).rejects.toThrow(/no credits/);
  });
});

describe("google listModels", () => {
  it("reads capability from supportedGenerationMethods rather than guessing", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
            { name: "models/imagen-4.0", supportedGenerationMethods: ["predictLongRunning"] },
            { name: "models/veo-3.0", supportedGenerationMethods: ["predictLongRunning"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ],
        }),
        { status: 200 },
      )) as typeof fetch);

    const models = await createGoogleAdapter({ GOOGLE_AI_API_KEY: "k" } as Env).listModels!();
    expect(models.map((m) => [m.id, m.capability, m.guessed])).toEqual([
      ["gemini-2.5-flash", "chat", false],
      ["imagen-4.0", "image", false],
      ["text-embedding-004", null, false], // embedding-only: nothing routes to it
      ["veo-3.0", "video", false],
    ]);
  });
});
