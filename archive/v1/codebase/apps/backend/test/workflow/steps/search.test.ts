import { beforeEach, describe, expect, it } from "vitest";
import { resetShared, shared } from "../preamble";
import { search } from "../../../src/workflows/steps/search";
import { runStep } from "../../../src/workflows/steps/step";
import { seedSearchRoute, stepContext } from "../harness";

// search (spec §3 step 3a): snippet-only, one billable call, null when there is nothing to search with.
beforeEach(resetShared);

describe("search step", () => {
  it("returns null and bills nothing without a web_search route", async () => {
    const ctx = await stepContext();
    expect(await runStep(shared.step as never, ctx, search, {})).toEqual({ results: null });
    expect(shared.step.bills).toEqual([]);
  });

  it("searches the profile's interests by default and the given query when one is passed", async () => {
    const ctx = await stepContext();
    await seedSearchRoute();
    shared.ai.respondWith("web_search", () => [{ title: "T", url: "https://t.example", snippet: "s" }]);
    expect(await runStep(shared.step as never, ctx, search, {})).toEqual({ results: [{ title: "T", url: "https://t.example", snippet: "s" }] });
    expect(shared.ai.callsFor("web_search")[0]!.input.messages[0]!.content).toContain("ai tooling");
    await runStep(shared.step as never, ctx, search, { query: "my topic" }, "topic");
    expect(shared.ai.callsFor("web_search")[1]!.input.messages[0]!.content).toBe("my topic");
    expect(shared.step.billedTasks("search")).toEqual(["web_search"]);
  });

  it("a failing search route is not fatal — null, and the next step lets the model search", async () => {
    const ctx = await stepContext();
    await seedSearchRoute();
    shared.ai.respondWith("web_search", () => {
      throw new Error("tavily down");
    });
    expect(await runStep(shared.step as never, ctx, search, {})).toEqual({ results: null });
  });
});
