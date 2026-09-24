# post-automate

Automated social content pipeline: discovers (or takes) topics, writes long-form articles
in each creator's voice with derivatives (hero image, X and LinkedIn versions, translation), routes every
AI task through a configurable multi-provider layer, publishes to Sanity after human
approval, and posts the approved X and LinkedIn versions to the creator's connected accounts.

Spec: [docs/requirement.md](docs/requirement.md) · Design: [docs/design.md](docs/design.md) ·
Article workflow: [docs/article-workflow.md](docs/article-workflow.md)

## Layout

| Path | What |
|---|---|
| `codebase/apps/backend` | Cloudflare Worker — Hono API, Workflows pipeline, AI router, Drizzle/Postgres |
| `codebase/apps/mobile` | Flutter app (users) |
| `codebase/apps/admin` | Admin web dashboard (routing config, monitoring, budgets) |
| `codebase/packages/shared` | Zod schemas + shared TS types (profile, task types) |
| `codebase/tools/` | Seed scripts, evals, run helpers |
| `docs/` | Requirements, design, article workflow, runbook |

Sanity Studio (post/author schemas) lives in the existing sites' repo — not here.

## Dev

```sh
cd codebase
pnpm install
pnpm typecheck
pnpm dev                    # backend on wrangler dev
tools/run-web.sh            # Flutter web on Chrome, pinned to port 8090
```

Secrets: never committed. Local dev uses `codebase/apps/backend/.dev.vars` (gitignored) — copy
`.dev.vars.example` and fill in values. Production uses `wrangler secret put`.
