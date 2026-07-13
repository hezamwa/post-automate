# post-automate

Automated social content pipeline: discovers (or takes) topics, writes long-form articles
in each creator's voice with derivatives (hero image, X version, translation), routes every
AI task through a configurable multi-provider layer, and publishes to Sanity after human
approval.

Spec: [docs/requirement.md](docs/requirement.md) · Design: [docs/design.md](docs/design.md)

## Layout

| Path | What |
|---|---|
| `apps/backend` | Cloudflare Worker — Hono API, Workflows pipeline, AI router, Drizzle/Postgres |
| `apps/mobile` | Flutter app (users) |
| `apps/admin` | Admin web dashboard (routing config, monitoring, budgets) |
| `packages/shared` | Zod schemas + shared TS types (profile, task types) |
| `tools/` | Seed scripts, evals, run helpers |
| `docs/` | Requirements, design, runbook |

Sanity Studio (post/author schemas) lives in the existing sites' repo — not here.

## Dev

```sh
pnpm install
pnpm typecheck
pnpm dev                    # backend on wrangler dev
tools/run-web.sh            # Flutter web on Chrome, pinned to port 8090
```

Secrets: never committed. Local dev uses `apps/backend/.dev.vars` (gitignored) — copy
`.dev.vars.example` and fill in values. Production uses `wrangler secret put`.
