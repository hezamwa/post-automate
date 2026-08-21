import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two projects, because the two kinds of test need different runtimes (NFR-16.1):
//
//  · "worker" — unit tests over modules that run inside the Worker. On the Workers pool,
//    so WebCrypto, `crypto.randomUUID` and the fetch globals behave as they do in prod.
//  · "db"     — tests that need a real database. PGlite is genuine PostgreSQL compiled to
//    WASM and needs Node APIs, so these run on the default pool. The code under test is
//    plain TS + Drizzle; the Workers runtime would add startup cost and no coverage.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              // NOTE: wrangler.jsonc deploys against "2026-07-01", but the workerd bundled
              // with the test pool only supports up to "2025-10-11" and silently falls back.
              // Pinned explicitly so the divergence is visible; raise it when the pool's
              // workerd catches up.
              compatibilityDate: "2025-10-11",
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ],
        test: { name: "worker", include: ["src/**/*.test.ts"] },
      },
      {
        test: { name: "db", include: ["test/db/**/*.test.ts"] },
      },
    ],
  },
});
