# Runbook — post-automate

> Operational procedures required by NFR-11.6 (secret rotation) and NFR-16.3 (backups &
> restore). Written 2026-08-21. The admin dashboard and `/admin/*` API referenced below
> require the admin role (FR-2.5).

---

## 1. Emergency controls (design §10.1)

| Situation | Action |
|---|---|
| Stop all AI spend NOW (including runs already in flight) | `PATCH /admin/flags/ai.paused {"value": true}` — or the Monitor tab's switch panel |
| Stop anything going live (drafting continues) | `PATCH /admin/flags/publishing.paused {"value": true}` |
| Stop new pipeline runs (in-flight ones finish) | `PATCH /admin/flags/runs.paused {"value": true}` |
| Stop one user only | `POST /admin/users/:id/suspend {"reason": "…"}` — reversible (FR-2.7) |
| Published something wrong | The draft's **Urgent retract** button (FR-7.6) — unpublishes the post *and* its translated edition |

Every switch change is audited (who/when — DR-9.13) and visible in `/admin/monitor`.
Admin-triggered route tests bypass `ai.paused` and the global cap; nothing else does.

---

## 2. Secret rotation (NFR-11.6)

**Cadence:** immediately on suspected exposure; otherwise at least every 6 months.

**Inventory** (per environment): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`,
`MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, `GROK_API_KEY`, `MANUS_API_KEY`,
`BRAVE_API_KEY` (FR-15.9); `SANITY_TOKEN_R9ZDT0S0`, `SANITY_TOKEN_5GZ3NGJS` (FR-8.4);
`JWT_SIGNING_KEY`, `FCM_SERVICE_ACCOUNT`, `SANITY_WEBHOOK_SECRET`; local dev additionally
`DATABASE_URL` in the gitignored `.dev.vars`.

**Procedure (any provider key):**
1. Create the new key in the provider's console; do not revoke the old one yet.
2. `wrangler secret put <NAME> --env staging` (repeat for `production` once it exists).
   Secrets propagate without a redeploy.
3. Re-test every route on that provider: dashboard → Routes → **Test**, or
   `POST /admin/ai/routes/:id/test`. Expect *"OK — model responded in … ms."*
4. Revoke the old key. Check `/admin/ai/health` again after a few minutes.
5. Update `.dev.vars` locally.

**Sanity tokens:** same procedure; create a new **Editor** token in the project's API
settings first. **`JWT_SIGNING_KEY`:** rotating it invalidates all sessions — users just
log in again (refresh tokens are DB-side and survive nothing here by design).
**`SANITY_WEBHOOK_SECRET`:** update the webhook's secret in the Sanity project settings
in the same sitting.

---

## 3. Backups (NFR-16.3)

### 3.1 Database — Neon point-in-time recovery
- Neon retains WAL history per branch ("history retention"). **Checklist item (one-time):**
  verify in the Neon console that retention for the staging branch is **≥ 7 days**
  (Project → Branches → History retention). Raise it if the plan default is lower.
- There is no job to run — PITR is storage-level and continuous.

### 3.2 Content — weekly Sanity export → R2
- The Worker exports **every creator project** (from `users.sanity_project_id`, so a new
  creator is picked up automatically) each **Sunday 03:00 UTC** (cron `0 3 * * 0`) to the
  R2 bucket `post-automate-backups`, keys `sanity/{projectId}/{dataset}/{YYYY-MM-DD}.ndjson`.
- This is the HTTP equivalent of `sanity dataset export`: every document as ndjson.
  **Asset binaries are not in the export** — they live on Sanity's CDN; the asset
  *documents* (with original source URLs) are included, and hero images are regenerable
  by the pipeline.
- **One-time setup, still pending:** R2 is not yet enabled on the Cloudflare account.
  Dashboard → R2 → enable (free tier suffices at these sizes), then
  `wrangler r2 bucket create post-automate-backups`, uncomment the `r2_buckets` binding
  in `wrangler.jsonc` (both env blocks), and deploy. Until then the weekly cron logs a
  loud error instead of silently not backing up.
- Verified 2026-08-21 against both live projects: r9zdt0s0 → 27 documents (159 KiB),
  5gz3ngjs → 148 documents (419 KiB). No pruning: a year of weekly exports is ~30 MiB.

### 3.3 Restore procedures
**Database (Neon):**
1. Neon console → Branches → **Restore** (or create a branch) from the timestamp just
   before the incident.
2. Point staging at it: create/attach a Hyperdrive config for the new branch's connection
   string, update the `hyperdrive` id in `wrangler.jsonc`, deploy. (Local: `DATABASE_URL`
   in `.dev.vars`.)
3. Re-run `pnpm db:migrate` if the branch predates the newest migrations — the drizzle
   journal makes this a no-op otherwise.

**Content (Sanity):**
1. Download the newest export: `wrangler r2 object get post-automate-backups/sanity/<proj>/production/<date>.ndjson --file backup.ndjson`.
2. Import with the CLI (from the site repo, which has sanity installed):
   `npx sanity dataset import backup.ndjson production --replace` — `--replace`
   overwrites documents with the same `_id`; use `--missing` to only fill gaps.
3. Spot-check the Studio; re-run any missing hero images via the pipeline's revise flow.

### 3.4 Restore rehearsal (required once before Phase 2 exit)
Status: **export verified live (2026-08-21); restore rehearsal pending — needs console access.**
Checklist to complete it (≈15 minutes, non-destructive):
- [ ] Neon: create a branch from a timestamp 1 hour ago; connect with `psql`/drizzle and
      `SELECT count(*) FROM drafts;` — matches expectations → delete the branch.
- [ ] Sanity: run step 3.3's import into a **throwaway dataset** (`npx sanity dataset
      create rehearsal`, import, `npx sanity dataset delete rehearsal`) — do NOT import
      into `production` during the rehearsal.
- [ ] Note the date + outcome here: `rehearsed: ____-__-__ by ____`.

---

## 4. Deploy & migrate

- **CI (on merge to `main`):** typecheck + full test suite; when the `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and `STAGING_DATABASE_URL` repo secrets are present, CI then
  migrates the staging DB and deploys the staging Worker (NFR-16.2). Until those secrets
  are added the deploy steps skip with a notice and deploys stay manual:
  `cd codebase/apps/backend && pnpm exec wrangler deploy --env staging`.
- **Migrations:** always via drizzle's journal (`pnpm db:migrate` with `DATABASE_URL` set,
  or CI) — never hand-written SQL against a live DB (NFR-16.2).
- **Production:** deliberately not wired yet — needs its own Neon branch + Hyperdrive
  config (`wrangler.jsonc` TODO), per-env secrets, and the tag-triggered deploy job.
