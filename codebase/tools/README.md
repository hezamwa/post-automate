# tools/

Cross-project scripts — code that belongs to no single app.

| Script | Purpose |
|---|---|
| `run-web.sh` | Flutter web dev on Chrome, pinned to port 8090 (stable origin → SecureStore persists) |
| `seed.ts` | Seed users (admin + creators), profiles, default AI routes (`DEFAULT_ROUTES`), user limits |
| `eval/` (later) | Golden-set prompt regression (NFR-16.1) — runs in CI on `ai/prompts/` changes |
| `sanity-export/` (later) | Weekly dataset export to R2 (NFR-16.3) |
