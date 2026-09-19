import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../../src/db/client";
import type { Env } from "../../src/shared/env";
import { techProfile } from "../fixtures";
import { createTestDb, seedRun, seedUser, type TestDb } from "./harness";

// Two-step web search (FR-5.4): with a 'web_search' route configured, discovery fetches real
// results and hands them to the chat model; with none, it falls back to the model's own
// search exactly as before. Against real Postgres because the decision is made by a route
// lookup, and adapters are mocked at their boundary — never the DB.

const chat = vi.fn();
const search = vi.fn();

vi.mock("../../src/ai/adapters", () => ({
  getAdapter: vi.fn((provider: string) =>
    provider === "tavily"
      ? { id: "tavily", capabilities: ["search"], search, healthCheck: vi.fn() }
      : { id: "anthropic", capabilities: ["chat"], chat, healthCheck: vi.fn() },
  ),
}));

const { findTopics } = await import("../../src/modules/discovery");

let db: TestDb;
let userId: string;
let runId: string;
const env = {} as Env;

const candidates = {
  text: "{}",
  parsed: { candidates: [{ title: "T", summary: "S", sourceUrls: ["https://x.example"] }] },
  usage: { inputTokens: 10, outputTokens: 10 },
};

beforeEach(async () => {
  db = await createTestDb();
  userId = await seedUser(db);
  runId = await seedRun(db, userId);
  vi.clearAllMocks();
  chat.mockResolvedValue(candidates);
  search.mockResolvedValue({
    results: [{ title: "Fetched headline", url: "https://found.example", snippet: "a real snippet" }],
    usage: { searches: 1 },
  });
  // chat route for discovery; both models priced so metering succeeds
  await db.insert(schema.aiRoutes).values({
    userId: null, taskType: "discovery", priority: 0, provider: "anthropic", model: "claude-sonnet-5",
  });
});

const ctx = () => ({ userId, runId, profile: techProfile() });

async function addSearchRoute() {
  await db.insert(schema.aiModels).values({
    provider: "tavily", model: "tavily-search", capability: "search", perSearchUsd: "0.008",
  });
  await db.insert(schema.aiRoutes).values({
    userId: null, taskType: "web_search", priority: 0, provider: "tavily", model: "tavily-search",
  });
}

describe("findTopics with no web_search route", () => {
  it("leaves the model to search for itself, as before", async () => {
    await findTopics(env, db, ctx());
    expect(search).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0].webSearch).toBe(true);
  });
});

describe("findTopics with a web_search route", () => {
  it("fetches results first and hands them to the chat model", async () => {
    await addSearchRoute();
    await findTopics(env, db, ctx());

    expect(search).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0];
    // the fetched result reaches the model...
    expect(prompt.messages[0].content).toContain("Fetched headline");
    expect(prompt.messages[0].content).toContain("https://found.example");
    // ...and the model is told to work from it rather than searching again
    expect(prompt.system).toMatch(/work only from them/);
    expect(prompt.webSearch).toBe(false);
  });

  it("bills the search separately, against the per-search price", async () => {
    await addSearchRoute();
    await findTopics(env, db, ctx());
    const spend = await db.select().from(schema.spendLedger);
    const searchRow = spend.find((r) => r.taskType === "web_search");
    expect(searchRow).toBeDefined();
    expect(Number(searchRow!.estCostUsd)).toBeCloseTo(0.008, 6);
  });

  it("falls back to LLM-native search when the search provider fails", async () => {
    // A worse brief beats no brief: a dead search route must not fail the whole run.
    await addSearchRoute();
    search.mockRejectedValue(new Error("tavily down"));
    const refs = await findTopics(env, db, ctx());

    expect(refs).toHaveLength(1);
    expect(chat.mock.calls[0]![0].webSearch).toBe(true);
    expect(chat.mock.calls[0]![0].system).toMatch(/Search the web before answering/);
  });
});
