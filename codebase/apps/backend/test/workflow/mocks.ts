import type { RunImageArgs, RunSearchArgs, RunTaskArgs } from "../../src/ai/router";
import type { TestDb } from "../db/harness";
import type { FakeStep } from "./fake-step";

// The three boundaries a workflow test fakes: the AI router (never a provider), the
// Sanity HTTP client, and FCM. The database is real (PGlite). Module factories take the
// per-file `shared` state so tests can script responses and inspect what happened.

export interface SharedState {
  db: TestDb;
  step: FakeStep;
  ai: FakeAi;
  sanity: { docs: Map<string, Record<string, unknown>>; mutations: unknown[] };
  pushes: Array<{ token: string; title: string; body: string; data?: Record<string, string> }>;
}

export const CANDIDATES = [
  { title: "Agents in production", summary: "Teams ship agents", whyItMatters: "hot", sourceUrls: ["https://a.example"] },
  { title: "Vector DB pricing", summary: "Costs fall", whyItMatters: "budget", sourceUrls: ["https://b.example"] },
  { title: "Rust in the browser", summary: "WASM grows", whyItMatters: "tooling", sourceUrls: ["https://c.example"] },
];

export const ANGLES = [
  { headline: "Angle zero", thesis: "t0", whyThisCreator: "w0", outline: ["a", "b", "c"] },
  { headline: "Angle one", thesis: "t1", whyThisCreator: "w1", outline: ["a", "b", "c"] },
  { headline: "Angle two", thesis: "t2", whyThisCreator: "w2", outline: ["a", "b", "c"] },
];

export function article(markdown = "# Article\n\nBody text.") {
  return { title: "Article title", slug: "article-title", excerpt: "An excerpt.", tags: ["ai"], imageAlt: "alt text", markdown };
}

type Responder = (args: RunTaskArgs) => unknown;

/** Canned structured responses per task type; override any of them per test. */
export class FakeAi {
  readonly calls: Array<{ taskType: string; input: RunTaskArgs["input"] }> = [];
  private overrides = new Map<string, Responder>();

  respondWith(taskType: string, fn: Responder): this {
    this.overrides.set(taskType, fn);
    return this;
  }

  chat(args: RunTaskArgs) {
    this.calls.push({ taskType: args.taskType, input: args.input });
    const parsed = this.overrides.get(args.taskType)?.(args) ?? FakeAi.defaults(args.taskType);
    const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    return { text, parsed: typeof parsed === "string" ? undefined : parsed, usage: {}, provider: "anthropic", model: "claude-sonnet-5", costUsd: 0 };
  }

  image(args: RunImageArgs) {
    this.calls.push({ taskType: args.taskType, input: { messages: [{ role: "user", content: args.prompt }] } });
    const override = this.overrides.get("image");
    if (override) override(args as unknown as RunTaskArgs);
    return { imageBase64: "AAAA", mimeType: "image/png", provider: "openai", model: "gpt-image-1", costUsd: 0.04 };
  }

  search(args: RunSearchArgs) {
    this.calls.push({ taskType: "web_search", input: { messages: [{ role: "user", content: args.query }] } });
    const results = (this.overrides.get("web_search")?.(args as unknown as RunTaskArgs) as unknown[] | undefined) ?? [];
    return { results, usage: { searches: 1 }, provider: "tavily", model: "tavily-search", costUsd: 0.008 };
  }

  callsFor(taskType: string) {
    return this.calls.filter((c) => c.taskType === taskType);
  }

  static defaults(taskType: string): unknown {
    switch (taskType) {
      case "discovery":
        return { candidates: CANDIDATES };
      case "research":
        return { ...CANDIDATES[0], keyFacts: ["fact one", "fact two"] };
      case "scoring":
        return { scores: [{ index: 0, score: 8, reason: "fits" }, { index: 1, score: 4, reason: "meh" }, { index: 2, score: 7, reason: "ok" }] };
      case "angles":
        return { angles: ANGLES, recommendedIndex: 1 };
      case "article":
        return article();
      case "shorten_x":
      case "shorten_linkedin":
        return "short post";
      case "translate":
        return { title: "عنوان", excerpt: "ملخص", imageAlt: "وصف", markdown: "# مرحبا" };
      default:
        throw new Error(`FakeAi: no default response for task '${taskType}'`);
    }
  }
}

/** Router mock: keeps the real NoRouteError/hasRouteFor, fakes the three provider entry points. */
export function routerMock(original: typeof import("../../src/ai/router"), shared: SharedState) {
  return {
    ...original,
    runTask: async (_env: unknown, _db: unknown, args: RunTaskArgs) => {
      shared.step.noteProviderCall(args.taskType);
      return shared.ai.chat(args);
    },
    runImageTask: async (_env: unknown, _db: unknown, args: RunImageArgs) => {
      shared.step.noteProviderCall(args.taskType);
      return shared.ai.image(args);
    },
    runSearch: async (_env: unknown, _db: unknown, args: RunSearchArgs) => {
      shared.step.noteProviderCall("web_search");
      return shared.ai.search(args);
    },
  };
}

type Mutation = { createOrReplace?: { _id: string }; patch?: { id: string; set?: Record<string, unknown> }; delete?: { id: string } };

/** In-memory Sanity: documents by id, every mutation recorded. */
export function sanityMock(shared: SharedState) {
  const docs = () => shared.sanity.docs;
  return {
    sanityToken: () => "tok",
    assertCanPublish: () => {},
    mutate: async (_env: unknown, _t: unknown, mutations: Mutation[]) => {
      for (const m of mutations) {
        if (m.createOrReplace) docs().set(m.createOrReplace._id, { ...m.createOrReplace });
        if (m.patch) Object.assign(docs().get(m.patch.id) ?? {}, m.patch.set ?? {});
        if (m.delete) docs().delete(m.delete.id);
      }
      shared.sanity.mutations.push(...mutations);
    },
    getDocument: async (_env: unknown, _t: unknown, id: string) => docs().get(id) ?? null,
    uploadImageAsset: async () => "image-fake-asset",
    publishDraft: async (_env: unknown, _t: unknown, draftId: string) => {
      const publishedId = draftId.replace(/^drafts\./, "");
      const doc = docs().get(draftId);
      if (doc) {
        docs().set(publishedId, { ...doc, _id: publishedId });
        docs().delete(draftId);
      } else if (!docs().has(publishedId)) {
        throw new Error(`Draft ${draftId} not found (and no published copy exists)`);
      }
      return publishedId;
    },
    retractPublished: async (_env: unknown, _t: unknown, id: string) => {
      const doc = docs().get(id);
      if (!doc) throw new Error(`Published doc ${id} not found`);
      docs().set(`drafts.${id}`, { ...doc, _id: `drafts.${id}` });
      docs().delete(id);
    },
    deleteDraft: async (_env: unknown, _t: unknown, id: string) => {
      docs().delete(id);
    },
  };
}

/** FCM mock: every push recorded, always "sent". */
export function fcmMock(shared: SharedState) {
  return {
    sendFcmPush: async (_env: unknown, token: string, msg: { title: string; body: string; data?: Record<string, string> }) => {
      shared.pushes.push({ token, ...msg });
      return true;
    },
    resetFcmTokenCache: () => {},
    buildFcmAssertion: async () => "assertion",
  };
}
