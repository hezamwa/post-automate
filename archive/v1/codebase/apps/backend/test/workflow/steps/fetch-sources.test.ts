import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { sourcesForRun } from "../../../src/db/queries";
import { fetchSourcesStep } from "../../../src/workflows/steps/fetch-sources";
import { runStep } from "../../../src/workflows/steps/step";
import { seedSearchRoute, stepContext } from "../harness";

// fetch-sources (spec §3 step 4): one extract call for the chosen topic, persisted once;
// no route or a failed fetch is not fatal.
beforeEach(resetShared);

describe("fetch-sources step", () => {
  it("fetches the pages in ONE billable call and persists them, deduplicated and capped", async () => {
    const ctx = await stepContext();
    await seedSearchRoute();
    const urls = ["https://a.example", "https://a.example", "https://b.example", "not a url"];
    expect(await runStep(shared.step as never, ctx, fetchSourcesStep, { urls })).toEqual({ fetched: 2 });
    expect(shared.step.billedTasks("fetch-sources")).toEqual(["web_search"]);
    const rows = await sourcesForRun(shared.db, ctx.runId);
    expect(rows.map((r) => [r.url, r.title])).toEqual([["https://a.example", "Page https://a.example"], ["https://b.example", "Page https://b.example"]]);
    // a retry replaces rather than duplicates (unique run + url)
    await runStep(shared.step as never, ctx, fetchSourcesStep, { urls }, "again");
    expect(await sourcesForRun(shared.db, ctx.runId)).toHaveLength(2);
  });

  it("includes a user-topic run's own links (FR-5.8)", async () => {
    const ctx = await stepContext({ userTopic: { title: "mine", links: ["https://mine.example"] } });
    await seedSearchRoute();
    await runStep(shared.step as never, ctx, fetchSourcesStep, { urls: ["https://found.example"] });
    expect((await sourcesForRun(shared.db, ctx.runId)).map((r) => r.url).sort()).toEqual(["https://found.example", "https://mine.example"]);
  });

  it("is skipped, not fatal, without a web_search route or when the fetch fails", async () => {
    const ctx = await stepContext();
    expect(await runStep(shared.step as never, ctx, fetchSourcesStep, { urls: ["https://a.example"] })).toMatchObject({ fetched: 0, skipped: expect.stringContaining("no web_search route") });
    await seedSearchRoute();
    shared.ai.respondWith("extract", () => {
      throw new Error("tavily down");
    });
    expect(await runStep(shared.step as never, ctx, fetchSourcesStep, { urls: ["https://a.example"] }, "again")).toEqual({ fetched: 0, skipped: "tavily down" });
    expect(await sourcesForRun(shared.db, ctx.runId)).toEqual([]);
  });
});
