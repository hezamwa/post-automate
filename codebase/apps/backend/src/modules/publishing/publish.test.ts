import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../shared/env";
import { publishDraft } from "./sanity";

// publishDraft convergence (AR-10.3, FR-8.1): a retried publish — or one that raced a
// Sanity Studio publish (the FR-8.6 webhook isn't built yet) — must succeed by
// converging on the published document, never 500. The Sanity HTTP boundary is faked.

const env = { ENVIRONMENT: "production", SANITY_TOKEN_TESTP: "tok" } as unknown as Env;
const target = { projectId: "testp", dataset: "production" };

function stubSanity(docs: Record<string, Record<string, unknown>>) {
  const mutations: unknown[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const doc = u.match(/\/data\/doc\/production\/(.+)$/);
    if (doc) {
      const found = docs[decodeURIComponent(doc[1]!)];
      return new Response(JSON.stringify({ documents: found ? [found] : [] }), { status: 200 });
    }
    if (u.includes("/data/mutate/")) {
      mutations.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch);
  return mutations;
}

afterEach(() => vi.unstubAllGlobals());

describe("publishDraft (FR-8.1, AR-10.3)", () => {
  it("publishes normally: copy to published id + delete the draft", async () => {
    const mutations = stubSanity({ "drafts.postauto-r1": { _id: "drafts.postauto-r1", title: "T" } });
    expect(await publishDraft(env, target, "drafts.postauto-r1")).toBe("postauto-r1");
    expect(mutations).toHaveLength(1);
  });

  it("converges when the draft is gone but the published copy exists (Studio publish / retry)", async () => {
    const mutations = stubSanity({ "postauto-r1": { _id: "postauto-r1", title: "T" } });
    expect(await publishDraft(env, target, "drafts.postauto-r1")).toBe("postauto-r1");
    expect(mutations).toHaveLength(0); // nothing to do — converged, not re-published
  });

  it("still fails loudly when NEITHER document exists", async () => {
    stubSanity({});
    await expect(publishDraft(env, target, "drafts.postauto-r1")).rejects.toThrow(/no published copy exists/);
  });

  it("refuses outside production regardless (FR-8.5)", async () => {
    stubSanity({ "drafts.postauto-r1": { _id: "drafts.postauto-r1" } });
    await expect(
      publishDraft({ ...env, ENVIRONMENT: "staging" } as Env, target, "drafts.postauto-r1"),
    ).rejects.toThrow(/writes drafts only/);
  });
});
