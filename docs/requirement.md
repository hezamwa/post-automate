# Requirements — Automated Social Content Pipeline ("post-automate")

> Derived from [app_overview.md](app_overview.md). This document restates the overview as testable requirements. Decisions the overview left open are collected in [§12 Open Decisions](#12-open-decisions) and referenced inline as **[OD-n]**. **As of 2026-07-13 all decisions are resolved** — the requirements are complete and ready for design.

**Requirement keying:** `FR` = functional, `NFR` = non-functional, `AR` = architecture/technical, `DR` = data. Priorities: **MUST** / **SHOULD** / **MAY** (RFC-2119 style).

---

## 1. Product Summary

A system that automatically discovers trending topics, generates personalized social/blog content in each creator's voice, and publishes it to Sanity CMS — for exactly **two known users**:

- **User A (Tech):** writes about technology (e.g., AI tooling, mobile development).
- **User B (Medical):** writes about medicine (e.g., cardiology, public health). This user's content is YMYL (Your Money or Your Life) territory and carries additional compliance requirements throughout this document.

**Stack (fixed, revised 2026-07-12):** TypeScript backend on **Cloudflare Workers** (Workflows for the pipeline, Cron Triggers for scheduling, Hyperdrive → managed PostgreSQL), Flutter mobile client, Sanity CMS for content. The Flutter app is a thin client; all logic, secrets, and integrations live server-side. *(The overview was written against a C#/ASP.NET Core stack; that decision was revisited and changed — see §10 and OD-5.)*

**Core pipeline per run:**

```
Discover topics → Score/filter against profile → Generate draft
  → Derivatives (hero image, X.com version, translation)
  → Approval → Publish to Sanity → Record outcome
```

---

## 2. Users, Accounts & Authentication

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | v1 ships with exactly two **seeded** user accounts — no self-serve registration, email verification, or password-reset flow yet. User provisioning MUST be data-driven: adding a user means inserting records, never changing code. | MUST |
| FR-2.2 | App ↔ backend authentication MUST use a simple JWT flow (or Firebase Auth if adopted for convenience), implemented behind an abstraction that can later grow into full identity (registration, password reset) without rework. | MUST |
| FR-2.3 | Each user MUST only see and act on their own profile, drafts, and pipeline runs. Every domain table MUST carry an owning user ID from day one. | MUST |
| FR-2.4 | The design MUST NOT assume "exactly two users" anywhere outside seed data — no hard-coded user IDs, no per-user configuration in code, no two-user assumptions in the UI. | MUST |
| FR-2.5 | Users MUST have a role (`user` \| `admin`). Admin-only endpoints (routing, budgets, monitoring, user management) require the admin role, and creating a user is an admin API action — data, not a code change. The admin interface is a **separate web dashboard**; the Flutter app stays user-only. **[OD-17 — resolved]** | MUST |
| FR-2.6 | An admin MUST be able to **delete a user** (right to erasure): cascades all personal DB records (profile versions, onboarding transcripts, drafts, edit diffs; spend-ledger rows are anonymized rather than deleted, to preserve accounting) and unassigns Sanity authorship. Whether published content stays up is an editorial decision — it is not auto-deleted. | MUST |

> **[OD-1 — RESOLVED]** This is a prototype expected to grow into a multi-user system soon. Consequence: do not build full multi-tenant infrastructure now, but every schema, auth, and pipeline decision must survive N users without a rewrite (FR-2.1–2.4).

---

## 3. Creator Profile (`Profiles` bounded context)

The Creator Profile is the input to every downstream prompt and is modeled as a DDD aggregate.

### 3.1 Profile contents

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | The profile MUST capture **Identity**: user ID, display name, Sanity author reference. | MUST |
| FR-3.2 | The profile MUST capture **Domain**: tech vs medical, plus sub-niches (e.g., "AI tooling, mobile dev" vs "cardiology, public health"). | MUST |
| FR-3.3 | The profile MUST capture **Voice**: tone descriptors, formality level, sentence-length preference, emoji/hashtag policy, hook style. | MUST |
| FR-3.4 | The profile MUST capture **Audience**: who the user writes for and the expertise level assumed. | MUST |
| FR-3.5 | The profile MUST capture **Topic policy**: weighted interests plus explicit exclusions/banned topics. Banned topics are hard constraints for the medical user. | MUST |
| FR-3.6 | The profile MUST capture **Cadence**: posts per week and preferred publish times. | MUST |
| FR-3.7 | The profile MUST capture **Language** preference — Arabic, English, or bilingual — as a per-user setting; no language is hard-coded anywhere in the pipeline. **[OD-3 — resolved]** | MUST |
| FR-3.8 | The profile SHOULD store 2–3 example posts (written or admired by the user) collected at onboarding, for use as few-shot generation examples. | SHOULD |
| FR-3.9 | The medical user's profile MUST carry explicit compliance constraints (e.g., "never give dosage advice, always append a disclaimer, never reference cases or the institution"). **[OD-6 — resolved]** | MUST |

### 3.2 Profile lifecycle

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.10 | Profiles MUST be stored as **versioned, immutable records** — never mutated in place — so profile versions can be diffed against content-quality outcomes when personalization drifts. | MUST |
| FR-3.11 | Users SHOULD be able to update their profile both by re-running the conversational onboarding and by directly editing fields in a settings form (chat for initial capture, form for tweaks). | SHOULD |
| FR-3.12 | The profile MUST carry a **channels** list (v1 values: `x`, `linkedin`) controlling which social derivatives are generated per article (FR-6.12) — channels are per-user config, never code (FR-2.4). | MUST |

---

## 4. Conversational AI Onboarding

The onboarding chat is a **structured extraction exercise driven by the backend**, not open-ended conversation.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Flutter MUST render a chat UI; every turn goes to the backend Worker API, which calls the LLM with a system prompt defining the interview goal and the target profile JSON schema. The client never calls the LLM directly. | MUST |
| FR-4.2 | Each LLM turn MUST use structured outputs / tool calling to return two things: (a) the next question to ask, and (b) the partially-filled profile object. The backend merges each partial profile into session state. | MUST |
| FR-4.3 | When all required profile fields are populated, the model MUST produce a natural-language summary ("Here's how I understand your voice…") and the user MUST confirm or correct it before the profile is persisted. | MUST |
| FR-4.4 | The interview MUST be capped at approximately 8–12 questions to avoid onboarding fatigue. | MUST |
| FR-4.5 | The interview MUST ask the user to paste 2–3 examples of posts they've written or admire (feeds FR-3.8). | MUST |
| FR-4.6 | Onboarding transcripts MUST be persisted for **30 days after profile confirmation** (to debug extraction quality), then automatically purged (see DR-9.2). **[OD-7 — resolved]** | MUST |
| FR-4.7 | The interview runs on a **Haiku-class** model, reserving Sonnet-class for content generation. **[OD-8 — resolved]** | MUST |

---

## 5. Topic Discovery (`Discovery` bounded context)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | The system MUST discover candidate trending topics per user per pipeline run, appropriate to the user's domain. | MUST |
| FR-5.2 | Candidates MUST be scored and filtered against the user's profile (interests, exclusions/banned topics) before generation. | MUST |
| FR-5.3 | All topic candidates per run MUST be persisted with their scores and rejection reasons (see DR-9.3) for tuning. | MUST |
| FR-5.4 | The discovery layer MUST be an **LLM with web search** ("find N trending topics in X this week, return JSON"), prompted per user from the profile's domain, sub-niches, and topic policy. **[OD-2 — resolved]** | MUST |
| FR-5.5 | Discovery prompts MUST account for the domain difference: recency of *research* for medical (new studies, guidelines), recency of *buzz* for tech. | MUST |
| FR-5.6 | Dedicated source integrations (Hacker News API, PubMed E-utilities, WHO/CDC RSS, Reddit) MAY be added later if LLM-search discovery quality disappoints. Google Trends MUST NOT be a dependency in any case (no official API; scraping is fragile). | MAY |
| FR-5.7 | Discovery and scoring MUST exclude topics the same user has covered or rejected within the **last 30 days** — recent topics are passed to the discovery prompt as exclusions and re-checked at scoring. **[OD-18 — resolved]** | MUST |
| FR-5.8 | Users MUST be able to request content on a **topic of their own** (title + optional notes and source links). Such runs replace discover/score with a **targeted research step** — LLM + web search on that specific topic, with user-provided links fetched as primary sources — then follow the normal pipeline (angles → article → derivatives → approval), preserving the no-fabrication rule: the article still cites real sources. **[OD-23 — resolved]** | MUST |

---

## 6. Content Generation & Personalization (`Generation` bounded context)

### 6.1 Prompt composition

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | Generation prompts MUST be **composed templates**, assembled per run: | MUST |

```
System prompt = base editorial rules
              + profile.voice (tone, structure, language)
              + profile.audience
              + few-shot examples (2–3 approved past posts)
              + domain guardrails (medical disclaimers, banned topics)
User prompt   = topic brief (title, why trending, source links, angle)
```

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.2 | Few-shot examples MUST rotate in the user's most recently **approved** posts so the voice adapts over time. | MUST |
| FR-6.3 | Generation MUST be a **two-step process** (two LLM calls): (1) given the topic and profile, propose 3 angles; (2) generate the draft from the selected angle. Scheduled runs auto-pick the angle; **user-requested runs (FR-5.8) present the 3 angles for the user to choose** (with a 24h timeout falling back to auto-pick). | MUST |
| FR-6.4 | Angle proposal and article generation use a Claude **Sonnet-class** model (strong Arabic support); topic scoring uses Haiku-class. **[OD-8 — resolved]** | MUST |
| FR-6.5 | The LLM MUST emit Markdown, not Portable Text (see FR-8.3). | MUST |

### 6.2 Medical guardrails

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.6 | For the medical user, generation prompts MUST hard-code guardrails: no diagnosis, no dosage advice, and a mandatory disclaimer block on every post. | MUST |
| FR-6.7 | Nothing resembling patient data may ever enter the pipeline. This project MUST remain fully separate from any hospital systems and data (KSMC context). | MUST |
| FR-6.8 | Medical content MUST NOT reference real cases, patients, or institutional information — hard-banned in the generation guardrails and checked on the approval screen. **[OD-6 — resolved: content is strictly educational/general]** | MUST |

### 6.3 Feedback loop

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.9 | When a user edits a draft before approval, the system MUST store the diff. | MUST |
| FR-6.10 | Stored edit diffs SHOULD periodically feed back into profile refinement (e.g., "the user consistently shortens intros — adjust"), either manually or via an automated profile-refinement job. | SHOULD |

### 6.4 Format

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.11 | The primary output format is **long-form articles** (target ~800–1,500 words unless the profile specifies otherwise). Short-form posts MAY be added later as a per-profile option. **[OD-13 — resolved]** | MUST |

### 6.5 Derivative content (v1 features — OD-15)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.12 | For every article draft, the pipeline MUST generate a **short social version per channel enabled in the profile's `channels` list** (v1 channels: **X.com** ≤280 chars; **LinkedIn** ≤3,000 chars, professional register) — each text-only, in the creator's voice, reviewed together with the article. Publishing to the channels themselves is out of scope for v1 — the texts are stored with the post for manual use. *(Extended for LinkedIn + per-profile channels 2026-07-16.)* | MUST |
| FR-6.13 | For every article draft, the pipeline MUST generate a **hero image** and attach it to the Sanity draft, reviewed and approved together with the article. Medical guardrails extend to imagery: abstract/schematic only, nothing implying real patients or procedures. | MUST |
| FR-6.14 | For bilingual users, **translation** MUST be an explicit pipeline task (generate in the primary language, then translate via the configured translation route), replacing single-call bilingual generation. Translation MUST also be available on demand per draft. | MUST |
| FR-6.15 | Voice narration, video, and code-snippet generation are **routing-ready task types only** (§15) — no product feature in v1. | — |

### 6.6 Content integrity

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.16 | Editorial rules MUST forbid verbatim reproduction of source material beyond short, attributed quotes; every article is an original synthesis that cites its sources. | MUST |
| FR-6.17 | Fetched source content MUST be treated as **data, never instructions** — stated explicitly in the generation prompts, with human approval as the second net against prompt injection from malicious pages. | MUST |
| FR-6.18 | **AI disclosure** is a per-profile flag, **default OFF**. When enabled, published posts carry a short "AI-assisted, reviewed by {author}" note; `generationMeta` stays internal either way. **[OD-22 — resolved]** | MUST |

---

## 7. Approval Workflow

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-7.1 | The pipeline MUST include a human-in-the-loop approval step for **both users** initially: push notification → review draft in app → approve / edit / **revise** / reject. Approval is a per-user flag, so the tech user can be switched to auto-publish later once the pipeline earns trust. **[OD-4 — resolved]** | MUST |
| FR-7.2 | For the medical user, human approval MUST be mandatory and non-negotiable. | MUST |
| FR-7.3 | Approval decisions (approve/edit/reject) MUST be persisted alongside the edit diffs (DR-9.4). | MUST |
| FR-7.4 | While a user has **two or more drafts pending review**, new pipeline runs for that user MUST be skipped (recorded with the reason; a reminder push is sent instead). **[OD-19 — resolved]** | MUST |
| FR-7.5 | At approval the user chooses **per draft**: publish immediately, or at the next preferred slot from the profile cadence. Scheduled publishes execute automatically at the chosen time. **[OD-20 — resolved]** | MUST |
| FR-7.6 | Post-publish corrections and edits happen in **Sanity Studio** (captured by webhook into the feedback loop, FR-8.6); the app additionally provides an **urgent retract (unpublish) button** on published posts. **[OD-21 — resolved]** | MUST |
| FR-7.7 | For **user-requested runs** (FR-5.8): compliance guardrails (FR-6.6–6.8) always apply — topic origin is irrelevant; a collision with the user's own banned-topics list warns and requires explicit override; the 30-day dedup (FR-5.7) informs but does not block; the pending-drafts gate (FR-7.4) does NOT apply (explicit intent); budget caps and rate limits (FR-15.8) are NEVER bypassed. **[OD-23 — resolved]** | MUST |
| FR-7.8 | Rejecting a draft MUST capture a **reason category**: *content quality* (feeds profile refinement), *wrong topic / changed my mind* (a discard — excluded from quality tuning but still counted in the 30-day dedup), or *other*. On rejection/discard the Sanity draft document is deleted and the stored markdown purged (DR-9.11). A **scheduled** draft MUST be cancellable before its publish time, returning it to pending review. **[OD-24 — resolved]** | MUST |
| FR-7.9 | The review screen MUST offer **request-revision**: free-text instructions regenerate the draft via the same article route with all guardrails intact; the channel versions and translation are re-derived (hero image kept unless the instructions address it); the draft returns to pending review. Maximum **3 revisions per draft**, each budget-metered. Revision instructions are stored and feed profile refinement (FR-6.10). A **change-angle** option regenerates from one of the other stored angle proposals instead. **[OD-24 — resolved]** | MUST |

---

## 8. Sanity Publishing (`Publishing` bounded context)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-8.1 | The system MUST publish content to Sanity as **draft documents** (`drafts.` prefix via the Mutations API), at least initially. Approval — in the app or Sanity Studio — triggers the actual publish. **[OD-9 — resolved]** | MUST |
| FR-8.2 | The Sanity `post` schema MUST include: author reference, body (Portable Text), topic tags, and a `generationMeta` object carrying model used, prompt version, source URLs, and pipeline run ID (for debugging "why did it write this"). | MUST |
| FR-8.3 | Markdown → Portable Text conversion MUST happen server-side in the Worker, using Sanity's JS-native tooling — a direct benefit of the TypeScript stack (no separate conversion service needed). The LLM MUST NOT be asked to emit Portable Text JSON directly (it produces malformed blocks). | MUST |
| FR-8.4 | Sanity access MUST use a **write-scoped (Editor) token per project**, stored server-side only, named by project (`SANITY_TOKEN_<PROJECTID>`). | MUST |
| FR-8.5 | Each creator publishes to their **own Sanity project** (their website's existing project), recorded on the user record (`sanity_project_id`, `sanity_dataset`) — adding a creator is a row plus one secret, never code (FR-2.4). There are **no separate staging datasets**: non-production environments write `drafts.*` only and MUST never publish. **[OD-10 — revised 2026-07-13]** | MUST |
| FR-8.6 | Sanity webhooks MUST flow back to the Worker: publish confirmation drives the pipeline state machine; Studio-edit events feed the edit-capture loop (FR-6.9). **[OD-11 — resolved]** | MUST |

---

## 9. Data Storage (DR)

**Ownership rule:** Sanity is the source of truth for **content**; the application database (managed PostgreSQL via Hyperdrive — AR-10.6) is the source of truth for **pipeline state**.

| ID | Requirement | Priority |
|----|-------------|----------|
| DR-9.1 | The database MUST store versioned profiles (FR-3.10). | MUST |
| DR-9.2 | The database MUST store onboarding transcripts for 30 days after profile confirmation, then purge them automatically — they may reveal the medical user's professional details. **[OD-7 — resolved]** | MUST |
| DR-9.3 | The database MUST store topic candidates per run, with scores and rejection reasons. | MUST |
| DR-9.4 | The database MUST store pipeline runs and their state machine: `discovered → drafted → pending-approval → published / failed`. | MUST |
| DR-9.5 | The database MUST store edit diffs and approval decisions for the feedback loop. | MUST |
| DR-9.6 | The database MUST NOT duplicate full post bodies after publish — store the Sanity document ID and fetch on demand. | MUST |
| DR-9.7 | The Flutter client MUST keep minimal local state (thin client; the backend does everything). | MUST |
| DR-9.8 | The database MUST store the AI routing configuration (task type → provider/model routes; global defaults and per-user overrides) as versioned records (FR-15.3). | MUST |
| DR-9.9 | The database MUST store AI health-check history: route tested, outcome, latency, and the human-readable message (FR-15.5). | MUST |
| DR-9.10 | The database MUST store per-user limits (monthly cap, runs/day, requests/min) and per-user spend records (FR-15.7–15.8). | MUST |
| DR-9.11 | The generated **markdown is stored with the draft until publish** — it is the app's editing source-of-truth and the diff base — then purged when the draft is published, rejected, or expired (after which DR-9.6 applies: Sanity holds the only copy). | MUST |
| DR-9.12 | Revision instructions MUST be stored per draft (revision number, instruction text) — alongside edit diffs, they are input to profile refinement (FR-6.10, FR-7.9). | MUST |

---

## 10. Architecture & Technology (AR)

> **Revised 2026-07-12 (OD-5):** the backend changed from ASP.NET Core (C#), as assumed in the overview, to **TypeScript on Cloudflare Workers**. Rationale: the user's websites already run on Cloudflare Workers, and single-platform operations was judged worth more than C# fluency. C# on Cloudflare was evaluated and rejected — Workers/Pages Functions run JS/TS/Python/Rust/WASM only; Blazor WASM on Pages is client-side-only; Containers is beta with sleep-on-idle semantics incompatible with a Hangfire-style always-on process. The DDD/CQRS **concepts** from the overview carry over unchanged; the .NET-specific technology choices do not.

| ID | Requirement | Priority |
|----|-------------|----------|
| AR-10.1 | The backend MUST be a **single Cloudflare Workers project in TypeScript** — a modular monolith, not microservices and not one-Worker-per-context. | MUST |
| AR-10.2 | The code MUST be organized into four bounded-context modules — `Profiles`, `Discovery`, `Generation`, `Publishing` — communicating via in-process interfaces/domain events, never network calls between modules. | MUST |
| AR-10.3 | Each pipeline run MUST execute as a **Cloudflare Workflow** instance with one durable step per stage (`discover → score → generate → derivatives → approval gate → publish → record`), with per-step retries. Steps MUST be idempotent. (LLM calls are I/O waits and do not consume Workers CPU budget, so runtime limits are not a practical constraint.) | MUST |
| AR-10.4 | Scheduled runs MUST use Cloudflare **Cron Triggers** that launch Workflow instances per user according to profile cadence (FR-3.6). This replaces Hangfire from the overview. | MUST |
| AR-10.5 | The approval gate (§7) SHOULD use the Workflow event-wait mechanism (`step.waitForEvent`) so a paused run resumes on the user's approve/reject action rather than polling. | SHOULD |
| AR-10.6 | The database is **Neon** (managed PostgreSQL — decided 2026-07-13), accessed via Cloudflare **Hyperdrive**. D1/SQLite is NOT acceptable for the relational model in §9. Data access uses Drizzle, preserving CQRS at module level: command handlers write, query handlers read. | MUST |
| AR-10.7 | The Flutter app MUST communicate exclusively with the Worker API — never directly with LLM providers, discovery APIs, or Sanity write APIs. | MUST |
| AR-10.8 | Hosting is **Cloudflare** (OD-5 resolved): Workers for compute, alongside the user's existing sites. No Azure/VPS component. | MUST |
| AR-10.9 | All AI calls MUST go through the internal **AI Router** module (§15) — task code never imports a provider SDK directly. Cloudflare AI Gateway remains the egress for providers it supports; the rest are called directly by their adapters. | MUST |

---

## 11. Security & Operational Safety (NFR)

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-11.1 | **All** API keys (Anthropic/OpenAI, Sanity tokens, discovery APIs) MUST live server-side only. No key may ever be embedded in the Flutter app binary (trivially extractable). | MUST |
| NFR-11.2 | Secrets MUST be managed via Wrangler secrets / Cloudflare Secrets Store bindings, injected at runtime — never committed as plaintext `vars` in `wrangler.jsonc` or anywhere else in the repo. | MUST |
| NFR-11.3 | The system MUST rate-limit and cap pipeline spend: max tokens per run and max runs per day, so a scheduling bug cannot burn the API budget overnight. Limits are enforced **per user** — monthly cap, runs/day, requests/min (FR-15.8) — in addition to the global ceiling. AI calls SHOULD be routed through **Cloudflare AI Gateway**, which provides spend caps, caching, and per-request logging on the chosen stack out of the box. | MUST |
| NFR-11.4 | Medical content is the primary risk surface (see FR-6.6–6.8): generation guardrails, mandatory approval, and strict separation from hospital systems/data are all MUST-level controls. | MUST |
| NFR-11.5 | The **global** monthly API spend ceiling is **US$20** — a **hard cap**: the application refuses all AI calls once it is reached (FR-15.10), independently of the AI Gateway cap that backstops it. Default per-user cap: **US$10/month** (configurable, FR-15.8). **[OD-12 — resolved; refined by OD-16]** | MUST |
| NFR-11.6 | Secrets MUST be rotatable without code changes: rotation = overwrite the Worker secret + re-test the affected routes (FR-15.5 confirms the swap with a human-readable result). Rotate immediately on suspected exposure and at least every 6 months; the per-secret procedure lives in the runbook (NFR-16.3). | MUST |
| NFR-11.7 | Logs MUST never contain secrets or credentials: Authorization headers, API keys, tokens, and password fields are redacted before any log write (Workers Logs, AI Gateway logs, spend ledger). Auth-route request bodies are never logged raw. | MUST |

---

## 12. Open Decisions

**All decisions are now resolved** (final resolutions 2026-07-13). The table records each resolution and its rationale; strikethrough shows the original question.

| ID | Decision | Affects | Notes from overview |
|----|----------|---------|---------------------|
| **OD-1** | ~~Permanently two users, or prototype for multi-tenant product?~~ **RESOLVED (2026-07-12): prototype, expected to grow to multi-user soon.** | FR-2.x, tenancy, auth | Design must be N-user-ready from day one (FR-2.4); full tenancy infrastructure deferred. |
| **OD-2** | ~~Discovery approach: LLM-with-web-search vs purpose-built APIs~~ **RESOLVED (2026-07-12): LLM with web search.** | FR-5.4 | Dedicated APIs remain a later fallback if quality disappoints (FR-5.6). |
| **OD-3** | ~~Language strategy~~ **RESOLVED (2026-07-12): per-user profile setting — Arabic, English, or bilingual; nothing hard-coded.** | FR-3.7, FR-6.4 | Claude's Arabic strength remains relevant to model choice (OD-8). |
| **OD-4** | ~~Approval-required vs fully automatic — per user~~ **RESOLVED (2026-07-12): approval required for both users initially; per-user flag allows relaxing the tech user later.** | FR-7.1 | Medical approval is permanently mandatory (FR-7.2). |
| **OD-5** | ~~Hosting target: Azure vs cheaper VPS~~ **RESOLVED (2026-07-12): Cloudflare Workers, backend rewritten in TypeScript.** | §10, NFR-11.2, NFR-11.3 | User's websites already run on Workers; single-platform operations preferred. C# on Cloudflare evaluated and rejected (Pages supports only client-side Blazor WASM; Containers is beta). |
| **OD-6** | ~~Could medical content ever reference real cases / institutional info?~~ **RESOLVED (2026-07-13): never — strictly educational/general.** | FR-3.9, FR-6.8 | Case/patient/institutional references hard-banned in guardrails and on the approval screen. |
| **OD-7** | ~~Retention policy for onboarding transcripts~~ **RESOLVED (2026-07-13): keep 30 days after profile confirmation, then auto-purge.** | FR-4.6, DR-9.2 | Window allows debugging bad profile extractions. |
| **OD-8** | ~~Model selection~~ **RESOLVED (2026-07-13): Haiku-class for interview & topic scoring; Sonnet-class for angles & article generation.** | FR-4.7, FR-6.4 | Partly superseded by OD-14: these are now the *default routes* in the AI routing config, changeable per task and per user without redeploy. |
| **OD-9** | ~~Draft-first vs straight publish~~ **RESOLVED (2026-07-13, follows OD-4): draft-first with approval for both users.** | FR-8.1 | Revisit only if the tech user later moves to auto-publish. |
| **OD-10** | ~~Sanity project layout~~ **REVISED (2026-07-13): one Sanity project per creator** — the sites already have separate projects (Waleed → `r9zdt0s0`, Afnan → `5gz3ngjs`). Production dataset only; staging isolation comes from the drafts-only rule (FR-8.5). | FR-8.4–8.5 | Original "one shared project" superseded by reality; per-project Editor tokens verified 2026-07-13. |
| **OD-11** | ~~Sanity webhooks back to the backend?~~ **RESOLVED (2026-07-13): yes.** | FR-8.6 | Publish confirmation drives pipeline state; Studio edits feed the feedback loop. |
| **OD-12** | ~~Monthly API budget ceiling~~ **RESOLVED (2026-07-13): US$20/month.** | NFR-11.3, NFR-11.5 | Enforced via AI Gateway caps + max-runs-per-day. |
| **OD-13** | ~~Content format and target length~~ **RESOLVED (2026-07-12): long-form articles (~800–1,500 words) as primary format; short-form may be added per-profile later.** | FR-6.11 | — |
| **OD-14** | **RESOLVED (2026-07-13): the AI layer is multi-provider** — Anthropic, OpenAI, Google Gemini, Moonshot, DeepSeek, Qwen (extensible) — with admin-managed routing (global default + per-user override per task type) and platform-owned API keys stored server-side. *Extended same day: + xAI Grok, Manus, Brave Search.* | §15, AR-10.9 | Users never supply or see provider keys (no BYOK). |
| **OD-15** | **RESOLVED (2026-07-13): v1 derivative features = X.com short version, hero image, translation.** Voice, video, and code snippets stay routing-ready task types only. *Extended 2026-07-16: + LinkedIn version; channel derivatives are driven by a per-profile `channels` list (FR-3.12).* | FR-6.12–6.15 | Publishing directly to X.com/LinkedIn deferred. |
| **OD-16** | **RESOLVED (2026-07-13): per-user spend cap defaults to US$10/month** (configurable per user) inside the global US$20 ceiling. | FR-15.8, NFR-11.5 | — |
| **OD-17** | **RESOLVED (2026-07-13): admin interface = separate web dashboard** (hosted alongside the existing Workers sites), consuming the same `/admin/*` API; Flutter stays user-only. | FR-2.5 | Same JWT flow; `role=admin` required. |
| **OD-18** | **RESOLVED (2026-07-13): topic dedup = 30-day exclusion window, per user.** | FR-5.7 | Cross-user dedup skipped — disjoint domains. |
| **OD-19** | **RESOLVED (2026-07-13): pipeline pauses at 2 pending drafts per user**; reminder push instead of a new run. | FR-7.4 | — |
| **OD-20** | **RESOLVED (2026-07-13): publish timing chosen per draft at approval** — immediately, or at the next preferred slot. | FR-7.5 | — |
| **OD-21** | **RESOLVED (2026-07-13): corrections in Sanity Studio (webhook-captured) + urgent in-app retract button.** | FR-7.6 | — |
| **OD-22** | **RESOLVED (2026-07-13): AI disclosure = per-profile flag, default OFF.** | FR-6.18 | — |
| **OD-23** | **RESOLVED (2026-07-13): user-requested topics supported** — a targeted-research entry into the same pipeline. Compliance guardrails always apply; banned-topic collisions warn with explicit override; dedup informs but doesn't block; the pending-drafts gate is bypassed; budget caps never are; the user picks the angle. | FR-5.8, FR-7.7, FR-6.3 | — |
| **OD-24** | **RESOLVED (2026-07-13): draft discard & revision loop** — reject captures a reason category (quality / changed-mind / other), deletes the Sanity draft, purges markdown; scheduled publishes are cancellable; request-revision regenerates with user instructions (≤3 per draft, metered, instructions feed refinement); change-angle reruns from a stored proposal. | FR-7.8–7.9, DR-9.12 | Discards still count toward the 30-day dedup. |

---

## 13. Phased Rollout

Ordering is deliberate: it front-loads the biggest risk (content quality) so failure is discovered in weeks, before any app is built around it.

### Phase 1 — Manual pipeline, one user (2–3 weeks)
- Backend only; no Flutter.
- Hard-code the tech user's profile.
- Trigger the pipeline via an endpoint.
- Publish drafts to Sanity; review in Sanity Studio.
- **Exit criterion:** discovery quality and voice matching validated.

### Phase 2 — Approval loop + Flutter shell
- Basic app: login, drafts queue, approve/edit/reject.
- Add the second (medical) user with a hand-written profile and the medical guardrails (FR-6.6–6.8, FR-7.2).

### Phase 3 — Conversational onboarding
- Build the chat-driven profile builder (§4).
- Re-onboard both users through it; compare output quality against the hand-written profiles.

### Phase 4 — Automation + feedback
- Cron Trigger scheduling (AR-10.4).
- Push notifications on new drafts.
- Edit-diff capture and profile refinement (FR-6.9–6.10).
- Small metrics view: topics surfaced, approval rate, edit distance.

---

## 14. Out of Scope

- Self-serve registration, email verification, password reset — deferred, not permanent (FR-2.1, OD-1).
- Microservices architecture (AR-10.1).
- Full multi-tenant infrastructure in v1 — but per OD-1, the design must not preclude it (FR-2.4).
- Google Trends integration (FR-5.4).
- LLM-emitted Portable Text (FR-8.3).
- Any connection to hospital systems or patient data (FR-6.7).
- Running C# anywhere on Cloudflare — Blazor WASM on Pages is client-side only; Containers is beta with sleep-on-idle. Evaluated and rejected under OD-5.
- Voice narration, video, and code-snippet generation as product features — routing-ready task types only (FR-6.15).
- Publishing directly to X.com — v1 generates the short text only (FR-6.12).
- Per-user provider API keys (BYOK) — platform keys only (OD-14).

---

## 15. AI Provider & Model Management (FR-15)

> Added 2026-07-13 (OD-14/15/16). The AI layer is provider-agnostic: which provider and model handles which task, for which user, is **configuration, not code**.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-15.1 | The system MUST support multiple AI providers behind a common adapter interface — initially **Anthropic, OpenAI, Google Gemini, Moonshot, DeepSeek, Qwen, xAI Grok, Manus, and Brave Search** (Brave is a search-capability provider, not an LLM) — such that adding a provider means adding an adapter plus registry entries, with no changes to task code. | MUST |
| FR-15.2 | The system MUST define a **task-type registry** covering at least: article generation, angle proposal, topic scoring, onboarding interview, channel shortening (X.com, LinkedIn), translation, image generation, voice (TTS), video, code snippets, web search/discovery, targeted topic research (FR-5.8), and profile refinement. Each task type declares the capability it requires (text, image, audio, video, search). | MUST |
| FR-15.3 | A **routing configuration** MUST map each task type to a route `{provider, model, params, fallbacks[]}` — a global default per task type plus optional per-user overrides — stored in the database as versioned records, editable by the admin via an API/screen, and effective without redeploy. | MUST |
| FR-15.4 | A **model registry** MUST list allowed models per provider with their capabilities and unit prices (per-MTok / per-image / per-second), used for route validation and cost computation. | MUST |
| FR-15.5 | The system MUST support **connectivity tests** of any configured route: on demand (with re-test) and on a daily schedule for enabled routes. Results MUST be stored with human-readable outcomes — success ("OK — model responded in 812 ms") or failure with cause and remediation ("Authentication failed — the OpenAI API key is invalid or expired; rotate the OPENAI_API_KEY secret and re-test"). | MUST |
| FR-15.6 | On provider failure (auth, quota, rate limit, timeout, server error), the router MUST try the route's fallbacks in order; every attempt and fallback MUST be recorded; a persistently failing primary route MUST notify the admin. | MUST |
| FR-15.7 | Every AI call MUST be metered **per user**: user, task type, provider, model, units consumed, computed cost — queryable as monthly per-user totals (DR-9.10). | MUST |
| FR-15.8 | **Per-user limits** MUST be enforced: monthly spend cap (default US$10, configurable per user), max pipeline runs per day, max requests per minute. Exceeding a limit MUST produce an informative, human-readable error or notification — never a silent failure. The global US$20 cap remains the backstop (NFR-11.5). | MUST |
| FR-15.9 | Provider API keys are **platform-owned**: one set per provider, stored as server-side secrets (NFR-11.1/11.2). Users never supply or see keys. | MUST |
| FR-15.10 | A **global budget hard cap** MUST be enforced in the application itself (not only at the gateway): when global month-to-date spend reaches the ceiling (NFR-11.5), ALL AI calls are refused — pipelines, derivatives, health canaries, everything — with a human-readable error, and the admin is notified. The AI Gateway cap remains the outer backstop. Alerts fire at 80% and 100% of the global cap. | MUST |
| FR-15.11 | **Global monitoring** MUST be available to the admin: month-to-date and daily spend broken down by user, provider, and task type; cap status (global and per user); route health overview; and pipeline run success/failure rates. Threshold breaches and route failures MUST push notifications — monitoring is active, not just a dashboard to remember to check. | MUST |

---

## 16. Engineering & Operations (NFR-16)

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-16.1 | Automated tests MUST cover the modules (unit tests on the Workers test pool) and the API routes (integration tests). Prompt changes MUST pass a small **golden-set regression** (recorded inputs → asserted outputs, e.g. "contains disclaimer block", "X version ≤ 280 chars") before deploy. | MUST |
| NFR-16.2 | CI/CD via GitHub Actions: merges deploy to a **staging** Worker (drafts-only Sanity access per FR-8.5, staging DB branch); production deploys are explicit (tag or manual approval). DB migrations run in CI — never by hand against production. | MUST |
| NFR-16.3 | Backups: point-in-time recovery enabled on the managed Postgres; weekly automated Sanity dataset export; the restore procedure documented and rehearsed once before Phase 2 exit. | MUST |
- Duplicating published post bodies in the application database (DR-9.6).
