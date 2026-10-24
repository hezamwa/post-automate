import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../../src/db/client";
import type { Env } from "../../src/shared/env";
import { techProfile } from "../fixtures";
import { createTestDb, seedRun, seedUser, type TestDb } from "./harness";

// Two-step web search (FR-5.4): with a 'web_search' route configured, the search step fetches
// real results and the synthesis step hands them to the chat model; with none, the model
// searches for itself. Against real Postgres because the decision is made by a route
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

const { discoveryQuery, searchSnippets, synthesizeCandidates } = await import("../../src/modules/discovery");

let db: TestDb;
let userId: string;
let runId: string;
const env = {} as Env;

const candidates = {
  text: "{}",
  parsed: { candidates: [{ title: "T", summary: "S", whyItMatters: "w", sourceUrls: ["https://x.example"] }] },
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

describe("without a web_search route", () => {
  it("searchSnippets returns null and synthesis leaves the model to search for itself", async () => {
    expect(await searchSnippets(env, db, ctx(), discoveryQuery(techProfile()))).toBeNull();
    await synthesizeCandidates(env, db, ctx(), null);
    expect(search).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0].webSearch).toBe(true);
  });
});

describe("with a web_search route", () => {
  it("fetches results first and hands them to the chat model", async () => {
    await addSearchRoute();
    const fetched = await searchSnippets(env, db, ctx(), discoveryQuery(techProfile()));
    await synthesizeCandidates(env, db, ctx(), fetched);

    expect(search).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0];
    // the fetched result reaches the model...
    expect(prompt.messages[0].content).toContain("Fetched headline");
    expect(prompt.messages[0].content).toContain("https://found.example");
    // ...and the model is told to work from it rather than searching again
    expect(JSON.stringify(prompt.system)).toMatch(/work only from them/);
    expect(prompt.webSearch).toBe(false);
  });

  it("bills the search separately, against the per-search price", async () => {
    await addSearchRoute();
    await searchSnippets(env, db, ctx(), "q");
    const spend = await db.select().from(schema.spendLedger);
    const searchRow = spend.find((r) => r.taskType === "web_search");
    expect(searchRow).toBeDefined();
    expect(Number(searchRow!.estCostUsd)).toBeCloseTo(0.008, 6);
  });

  it("falls back to LLM-native search when the search provider fails", async () => {
    // A worse brief beats no brief: a dead search route must not fail the whole run.
    await addSearchRoute();
    search.mockRejectedValue(new Error("tavily down"));
    const fetched = await searchSnippets(env, db, ctx(), "q");
    expect(fetched).toBeNull();
    const refs = await synthesizeCandidates(env, db, ctx(), fetched);
    expect(refs).toHaveLength(1);
    expect(chat.mock.calls[0]![0].webSearch).toBe(true);
    expect(JSON.stringify(chat.mock.calls[0]![0].system)).toMatch(/Search the web before answering/);
  });
});
