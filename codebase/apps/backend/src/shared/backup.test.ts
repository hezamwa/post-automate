/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { backupObjectKey, exportProjectToR2 } from "./backup";

// Weekly Sanity export → R2 (NFR-16.3): a real (miniflare) R2 bucket receives the
// ndjson; only the Sanity HTTP boundary is faked. Auth uses the per-project token
// exactly as publishing does (FR-8.4).

const NDJSON = '{"_id":"a","_type":"post"}\n{"_id":"b","_type":"post"}\n{"_id":"c","_type":"blogPost"}\n';

function bucket(): R2Bucket {
  return (testEnv as { BACKUPS: R2Bucket }).BACKUPS;
}

describe("backupObjectKey", () => {
  it("is date-stamped and per project/dataset", () => {
    expect(backupObjectKey("r9zdt0s0", "production", new Date(Date.UTC(2026, 7, 23)))).toBe(
      "sanity/r9zdt0s0/production/2026-08-23.ndjson",
    );
  });
});

describe("exportProjectToR2 (NFR-16.3)", () => {
  it("streams the export into R2 with the project token and reports counts", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(NDJSON, { status: 200 });
    }) as typeof fetch;

    const env = { SANITY_TOKEN_TESTPROJ: "secret-token" } as unknown as Env;
    const result = await exportProjectToR2(
      env,
      bucket(),
      { projectId: "testproj", dataset: "production" },
      new Date(Date.UTC(2026, 7, 23)),
      fakeFetch,
    );

    expect(calls[0]?.url).toBe("https://testproj.api.sanity.io/v2021-06-07/data/export/production");
    expect(calls[0]?.auth).toBe("Bearer secret-token");
    expect(result).toEqual({ key: "sanity/testproj/production/2026-08-23.ndjson", bytes: NDJSON.length, documents: 3 });

    const stored = await bucket().get(result.key);
    expect(await stored?.text()).toBe(NDJSON);
    expect(stored?.httpMetadata?.contentType).toBe("application/x-ndjson");
  });

  it("throws on an export failure — the caller logs per project, never silently", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const env = { SANITY_TOKEN_TESTPROJ: "t" } as unknown as Env;
    await expect(
      exportProjectToR2(env, bucket(), { projectId: "testproj", dataset: "production" }, new Date(0), fakeFetch),
    ).rejects.toThrow(/HTTP 401/);
  });
});
