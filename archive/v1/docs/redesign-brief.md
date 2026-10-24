# post-automate: a redesign brief

> **For the AI reading this.** This document describes an app that already exists: what it does,
> who it is for, how it is built, what was decided along the way and why, and where it stands
> today. It contains no code. I want your help to **rethink and re-design the app**. Treat
> everything here as the current state, not as a constraint, unless it is listed in
> [§27 Constraints](#27-constraints-likely-to-survive-a-redesign). Ask me questions **one at a
> time**. Challenge decisions where you think they are wrong.

---

## 1. Goals for this conversation

*(To be filled in by the owner before sharing: what feels wrong today, what the redesign should
achieve, and what is off the table.)*

- Why I want to rethink it:
- What a good outcome looks like:
- What must not change:

---

## 2. The product in one paragraph

**post-automate** is a personal content pipeline for a small number of creators. It finds a
topic that is trending in a creator's field, or takes one the creator gives it. It then writes a
long-form article (about 800–1,500 words) in that creator's own voice, with a hero image, short
versions for X and LinkedIn, and an optional translated edition. The creator reviews everything
on their phone and approves, edits, revises or rejects it. Approved articles are published to the
creator's **own website** (each site runs on Sanity CMS), and the short versions are posted to the
creator's X and LinkedIn accounts. Every AI task is routed through a configurable layer that can
use many AI providers, with hard spending limits and emergency stop switches.

---

## 3. History and context

- **This is the third attempt.** The first two were scrapped. The owner has asked for careful,
  deliberate progress so it isn't rebuilt a fourth time.
- **Origin.** The idea started as a brainstorm with an AI. That brainstorm assumed a C#/.NET stack
  (ASP.NET Core, Hangfire, EF Core), because the owner works mainly in .NET and Flutter and likes
  Domain-Driven Design and CQRS.
- **Stack change (2026-07-12).** The backend was moved to **TypeScript on Cloudflare Workers**,
  because the owner's websites already run on Cloudflare and running everything on one platform
  was judged worth more than staying in C#. C# on Cloudflare was looked at and rejected: Workers
  don't run .NET, Blazor on Pages is client-side only, and Containers was in beta and sleeps when
  idle.
- **Timeline:**
  - 2026-07-13: scaffold.
  - 2026-07-16: first real pipeline run and first real Sanity drafts.
  - 2026-08-21: auth, kill switches and the profile language split.
  - 2026-08-22: production went live.
  - 2026-09-20: the "v2" article workflow, which added many decision points.
  - 2026-09-24: "Phase 6": mood, the profile page, and X/LinkedIn posting.
- **Size.** About 55 commits. 445 backend tests and 35 tests in the shared package. One backend,
  one Flutter app, one admin web app.
- **The owner** is a software engineer (strong in .NET and Flutter, Sanity, Cloudflare). They are
  both the developer/admin and one of the two creators.

---

## 4. Users and roles

| Who | Field | Notes |
|---|---|---|
| **Creator A: Waleed** (also the owner/admin) | Tech: AI tooling, mobile development | Writes in English. Personal site on Sanity. |
| **Creator B: Afnan** | Medical: e.g. cardiology, public health | YMYL content ("your money or your life"). Strict compliance rules apply. Personal site on Sanity, with two blog types: `public` and `em`. Writes in English; Arabic editions only on request. |

- **Exactly two users today, seeded by hand.** There is no sign-up, email verification or password
  reset.
- **The design must still work for N users.** It is a prototype "expected to grow into a
  multi-user system soon". Nothing may hard-code a user, and adding a creator means adding a
  database row and one secret, never changing code.
- **Roles:** `user` and `admin`. The admin works in a separate web dashboard, and the mobile app
  is for creators only.
- **Account states:** an admin can suspend and reactivate a creator (reversible) or erase one
  (right to erasure). Erasing is refused for an admin who appears in the audit trail.

---

## 5. The creator's journey today

1. **Start a run.** The creator either:
   - taps **Generate**, and the system finds a topic;
   - uses **My topic**, giving a title plus optional notes and links;
   - or leaves it to a daily schedule, if they turned on `autoRun` (off by default, and only for
     creators active in the last 7 days).

   They can pick a **mood** for the article (see §13).
2. **Answer the choices** the run asks for: topic, angle, outline and image concept. Each of these
   is a "gate" that the creator can set to *ask me* or *decide for me* (§7). A creator who just
   tapped Generate is usually still in the app, so these resolve in one sitting.
3. **Get a push notification** when the draft is ready, with the article, hero image and
   quality-check findings.
4. **Review the draft** and choose one:
   - **approve**, optionally after editing the text;
   - **revise**, with free-text instructions (at most 3 times);
   - **change angle**;
   - **reject**, with a reason.

   When approving, the creator ticks which extras they want: X version, LinkedIn version, and the
   Arabic (or other) edition.
5. **Publish gate.** The creator sees the generated X and LinkedIn texts, can edit them, and
   chooses **now**, **next preferred slot**, or **hold**.
6. **The article goes live** on their website, plus the translated edition if they asked for one.
7. **Social posts.** These go out automatically, or after the creator taps **Post** on each
   channel (a per-creator setting). On X, the link to the article follows as a reply. On
   LinkedIn, the link is the last line of the post.
8. **Afterwards.** The creator can urgently **retract** a published article, which also deletes
   its social posts. Corrections are made in Sanity Studio.

The guiding principle of v2: **the only money spent is money a creator asked to spend.** Scheduled
jobs do only free work, such as reminders, publishing scheduled posts and health checks, unless
the creator opted into `autoRun`.

---

## 6. The article pipeline, step by step

Each run is one long-lived, durable workflow. It survives restarts and can pause for days at a
decision point. Each step makes at most **one** paid AI call, so a retry never pays twice for a
call that already succeeded.

| # | Step | What it does | AI tier |
|---|---|---|---|
| 1 | Entry checks | Checks the budget caps (global and per creator), the rate limit, the kill switches, and whether the creator is suspended. Skips if the creator already has an undecided draft. For scheduled runs, also checks that the creator was active recently. | none |
| 2 | Load profile | Pins the creator's current profile version for the whole run. | none |
| 3a | Search | A cheap, snippet-only web search on the creator's interests. | search |
| 3b | Candidates | Turns the snippets into 8–10 candidate topics, each with a title, why it matters and source links. | small model |
| 3c | Score | Scores each candidate from 1 to 10 against the profile, with a reason. A topic needs 6 or more; if none qualifies, the run ends as "skipped". | small model |
| 3d | Research | *My-topic runs only:* takes the place of 3b–3c. Builds a brief from the search results and the creator's links. | small model |
| 4 | Fetch sources | Fetches the full content of the chosen topic's sources. This is what grounds the article. | search |
| 5 | Angles | Proposes 3 angles and recommends one. | large model |
| 6 | Outline | Produces headings with 1–2 key points each. | small model |
| 7 | Draft | Writes the article in Markdown. | large model |
| 8 | Quality check | Checks the disclaimer, medical language, language, length, banned topics, similarity to recent topics, and whether the outline was followed. On a fail it revises automatically once, then moves on either way. | small model |
| 9 | Save draft | Stores the draft. The Markdown is the editing copy until the article is published. | none |
| 10 | Image concepts | Writes 2–3 hero-image ideas as text. | small model |
| 11 | Hero image | Generates the chosen image and uploads it to Sanity. | image model |
| 12 | Sanity draft | Converts Markdown to Sanity's rich text and writes a hidden draft on the creator's site. | none |
| 13 | Notify | Sends the "draft ready" push. | none |
| 14–16 | Derivatives | *After approval:* writes the X version (≤280 chars), the LinkedIn version and the translation, all from the **final approved text**, and only the ones the creator ticked. | small / large |
| 17 | Publish | Publishes the article, then the translated edition (best effort), then the social posts. | none |
| 18 | Record | Closes the run and saves every choice as a signal for tuning the profile later. | none |

**What a run costs.** A run abandoned at the topic gate costs one search and two small-model
calls. A finished draft costs about: two searches, five small-model calls, two large-model calls
and one image. The early estimate was about **$0.25 per article**.

**How runs end:**

| Ending | Meaning |
|---|---|
| `published` | The article went live. |
| `rejected` | The creator rejected the draft. |
| `skipped` | No good topic, an undecided draft already existed, or runs were paused. |
| `failed` | Retries ran out, a budget cap was hit, or the model answered `CANNOT_COMPLY` on medical content. |
| `abandoned` | A choice before the draft went unanswered for 30 days. |

---

## 7. Gates: where the creator decides

A **gate** is a point where the run stops and offers options. Every gate uses the same shape: a
list of options, each with a title, summary and reason, plus a recommended option. The creator
picks an option or types free text, such as "something about X instead".

Each gate has its own per-creator setting, `ask` or `auto` (auto takes the recommended option):

| Gate | Default | Options | Free text becomes |
|---|---|---|---|
| Topic | auto | The scored candidates | A My-topic research run |
| Angle | auto | 3 angles | A fourth angle |
| Outline | auto | One outline, which can be approved, edited or regenerated | Instructions for a new outline |
| Image | auto | 2–3 concepts, or no image | A custom concept |
| **Draft** | always ask | approve / revise / change angle / reject | — |
| Derivatives | ask | Tick X, LinkedIn and the translation, in any combination (shown on the approve screen) | — |
| Publish | auto | now / next slot / hold, with the texts editable | Edits to the X/LinkedIn text |

**Waiting behaviour:**
- The run waits silently for 2 minutes, because the creator is probably still in the app.
- Then it sends a push and waits up to 30 days, with a reminder on day 3.
- An unanswered gate before the draft ends the run as `abandoned`. It never carries on
  automatically, because that would spend money on someone who has gone quiet.
- The **draft gate never expires.** Reminders come on day 6, then weekly. If the workflow's own
  wait limit runs out, the draft is marked *stale*: approve and reject still work, but revise and
  change angle don't.

**Auto-publish** is an admin-only flag, off by default, and impossible to enable for a medical
profile. It auto-approves a draft that has waited 7 days, but only if:
- the quality check passed without a revision;
- the creator opened the draft at least once;
- a warning push with a one-tap Hold went out 24 hours earlier.

---

## 8. Draft lifecycle and review rules

```
pending_approval → (revise / change angle, max 3) → pending_approval
pending_approval → approve → derivatives → publish gate → published | scheduled | back to pending
scheduled → (hourly publisher) → published        scheduled → cancel → pending_approval
pending_approval → reject → rejected               published → retract → retracted
```

- **Only one undecided draft at a time.** While one exists, Generate opens it instead of starting
  a new run. (v1 allowed two.)
- **Rejecting asks for a reason:**
  - *content quality*: feeds tuning;
  - *changed my mind / wrong topic*: excluded from tuning;
  - *other*.

  On rejection the Sanity draft is deleted and the text purged. The topic still counts toward the
  30-day no-repeat window.
- **Revisions** keep the hero image unless the instructions mention it. Each revision is
  budget-metered, and the instructions are stored for tuning.
- **Edits made at approval** are stored as diffs for the feedback loop.
- **Medical drafts** show a compliance checklist that the creator must tick.
- **Publish timing** is chosen per draft: now, or the next preferred slot from the profile's
  cadence.

---

## 9. Derivatives

| Derivative | Rule |
|---|---|
| **X version** | Must be ≤280 characters. This limit is enforced strictly: the text is trimmed at a word boundary if needed, both when it is generated and when it is posted. |
| **LinkedIn version** | Must be ≤3,000 characters in a professional register: a strong first line, 2–4 short paragraphs, at most 3 hashtags. |
| **Translation** | Opt-in (see the profile). Always a separate task after the article is written, never generated in the same call. Produces a full second document in the target language (title, excerpt, image alt text, body). |
| **Hero image** | An editorial illustration with no text or logos. For medical content, abstract or schematic only, with no realistic patients or procedures. |

**When a derivative doesn't arrive**, it never breaks the run. Each one is recorded with an
outcome:

| Outcome | Meaning |
|---|---|
| `produced` | It was generated. |
| `declined` | The creator didn't tick it. |
| `skipped` | No AI route is enabled for that task. |
| `failed` | It was attempted, with the reason recorded. |
| *(no record)* | The profile doesn't use that channel. |

If a requested translation fails, the article still publishes, with the failure shown.

**Planned but not built:** voice narration, video and code-snippet generation. Each of these
exists only as a task type that could be given a route later.

---

## 10. Publishing to the creators' websites (Sanity)

- **One Sanity project per creator:** each creator's existing website project. The project ID and
  dataset are stored on the user record.
- **Sanity is the source of truth for content.** The app's database is the source of truth for
  pipeline state. After publishing, the article body is deleted from the app database.
- **Draft first.** The pipeline writes a hidden draft, and approval publishes it.
- **Field mapping per site.** The pipeline adapts to each site's existing blog type instead of
  imposing a shared one. The two sites differ in:
  - field names (body, image and date fields);
  - required alt text;
  - slug rules (Arabic titles are transliterated);
  - Afnan's per-draft `public`/`em` blog type, chosen at approval;
  - how translations are modelled: on Waleed's site a translation is one document per language;
    on Afnan's it is linked through an i18n plugin.
- **Fields added to both sites:** an AI disclosure flag, the X text, the LinkedIn text, and a
  read-only block that records which provider, model, prompt version, run and sources produced
  the post.
- **Markdown in, rich text out.** The AI writes Markdown, and the server converts it to Sanity's
  rich-text format. The AI is never asked to produce that format directly, because it gets it
  wrong.
- **Staging never publishes.** Non-production environments write hidden drafts only; there is no
  separate staging dataset.
- **Studio edits after publishing** were meant to flow back through a webhook into the feedback
  loop. That webhook is **not built yet**.

---

## 11. Social posting (X and LinkedIn)

- Creators connect their own accounts through each platform's **official OAuth consent screen**.
  The system never asks for, receives or stores a social-platform password.
- Tokens are encrypted at rest, are never returned by any API, and the creator can disconnect.
- Social posting happens only after the article is live, and only for channels that were ticked,
  produced and connected.
- The **posting mode** is per creator: `confirm` (the default, tap Post per channel) or `auto`.
- **On X:** the post is the text alone, then the article link as a reply.
- **On LinkedIn:** the text, then the link on the post's last line. The first plan was to put the
  link in the first comment, but LinkedIn refuses comments without a partner-only API.
- No image is uploaded to either platform.
- A social failure never affects the article. **Retry** posts only the missing part, never a
  duplicate.
- Retracting an article deletes its social posts (best effort).
- LinkedIn tokens last about 60 days with no refresh, so the creator has to reconnect regularly.
  They get a push 7 days before the token expires.
- The article URL is built from the site's base URL plus a path for each site. Without a base URL,
  the post fails with that reason rather than going out with a broken link.
- **Live status:** LinkedIn posting works. X answered the first live post with
  `403 not permitted`. At least part of the cause was a 310-character text, now capped. Whether
  the X plan or app permissions are also a problem is still unconfirmed.

---

## 12. The creator profile

The profile is the input to every prompt. It is **versioned and append-only**: every save creates
a new version, and each run pins the version it used. Each stored profile also records which
schema shape it was written against, so old versions stay readable.

| Area | Contents |
|---|---|
| Identity | Display name |
| Domain | `tech` or `medical`, plus sub-niches |
| Voice | Tone words; formality (casual/neutral/formal); sentence length; emoji policy; hashtag policy; hook style |
| Audience | Description; expertise level (general/informed/expert) |
| Topic policy | Weighted interests (1–5); banned topics (hard constraints) |
| Cadence | Posts per week; preferred days; preferred hour |
| Language | The primary language the article is written in (`ar` or `en`) |
| Translation | Off, or on with a target language that differs from the primary one |
| Format | Article; target word count (default 1,200) |
| Example posts | 2 or more posts the creator wrote or admires, used as few-shot examples |
| AI disclosure | On or off (default off). When on, posts carry an "AI-assisted, reviewed by {author}" line. |
| Channels | X and/or LinkedIn |
| Social posting mode | `confirm` or `auto` |
| Gates | `ask` or `auto` for each gate (§7) |
| autoRun | Whether scheduled runs are on |
| Compliance | *Required for medical profiles:* no diagnosis, no dosage, no case or institution references, and the exact disclaimer text |

- **Editing.** Creators edit their profile on a **profile page** in the app. A read-only **"My
  data"** section shows everything the system stores about them, but never tokens. Only an admin
  can delete data.
- **Onboarding (planned, not built).** A chat interview of 8–12 questions on a cheap model. Each
  turn returns the next question plus the profile filled in so far. It ends with a summary that
  the creator confirms, and it asks for 2–3 example posts. Transcripts would be kept for 30 days,
  then purged. Today both profiles were written by hand.
- **Feedback loop (planned, not built).** The system is meant to learn from edit diffs, revision
  instructions, rejection reasons and gate choices, proposing profile changes the creator accepts
  with one tap. Today these signals are **stored but not used**. Even the "few-shot from recently
  approved posts" feature still falls back to the hand-entered example posts.

---

## 13. Mood (per article)

When starting a run, the creator can choose a mood:
- `normal` (the default)
- `optimistic`
- `excited`
- `very_excited`
- `concerned`
- `disappointed`
- `critical`

The mood adjusts the voice but doesn't replace it, and it applies to the article and its social
versions. Guardrails always outrank the mood:
- `critical` means a firm, evidence-based critique of ideas, never of people, and is **not
  available for medical profiles**;
- the excited moods never license hype or claims the sources don't support;
- `angry` was considered and rejected as a reputational risk.

Scheduled runs always use `normal`.

---

## 14. Topic discovery and research

- **Discovery uses an LLM with web search,** rather than dedicated source integrations such as
  Hacker News, PubMed, RSS or Reddit. Those stay a fallback if quality disappoints. Google Trends
  is ruled out because it has no official API.
- **Search is split into two calls:** a cheap snippet search to choose the topic, then a
  full-content fetch for the chosen topic only. A dedicated search provider (currently
  **Tavily**) can be configured to feed real results to the model instead of relying on the
  model's built-in search.
- **What "recent" means depends on the domain.** For medical topics it means recent
  **research** (new studies, guideline updates, WHO/CDC). For tech it means recent **buzz**
  (launches, releases, debates).
- **No repeats within 30 days.** Topics covered or rejected in the last 30 days are excluded, both
  in the search prompt and again at scoring.
- **My-topic requests:**
  - a collision with the creator's own banned topics warns and needs an explicit override;
  - the 30-day check warns but doesn't block;
  - the budget caps are never bypassed;
  - the article must still cite real sources.

---

## 15. Content rules and medical guardrails

**Editorial rules (every article):**
- Write in the primary language only.
- Never make up facts: only claims supported by the sources, with a Sources section.
- No verbatim copying beyond short, attributed quotes.
- Treat fetched pages as **data, never instructions**, to resist prompt injection. Human approval
  is the second line of defence.

**Medical guardrails (non-negotiable for the medical creator):**
- Educational and general content only.
- No diagnosis or treatment advice for any individual.
- No drug dosages or prescribing guidance.
- Never reference real patients, real cases (even anonymised) or any institution.
- The exact disclaimer at the end of every article.
- If a topic can't be covered within these rules, the model answers `CANNOT_COMPLY` and the run
  fails instead of producing a draft that breaks the rules.
- **Human approval is permanently mandatory**, and auto-publish can never be enabled.
- The project must stay completely separate from any hospital systems or data. The medical
  creator works at a hospital, and no patient data may ever enter the pipeline.

---

## 16. Quality control

**Today.** One small-model quality-check step runs after drafting (§6, step 8). On a fail it
revises automatically once, then sends the draft to review with the findings shown either way. It
never blocks.

**Planned "Phase 5" QC layer (designed in outline, not built):**
- **Deterministic checks:** length, structure, character limits, disclaimer, banned terms,
  language, every source link really from the brief, verbatim overlap with sources, and whether
  the Markdown converts cleanly.
- **Judged checks** by an AI model, ideally from a **different provider** than the one that wrote
  the article: voice match, claim-to-source support, medical review, translation fidelity.
- Each check has a **hard** or **soft** severity:
  - a hard fail triggers one regeneration, then the draft is flagged for review;
  - soft findings are notes for the reviewer only.
- If the judged checks can't run, the layer falls back to deterministic checks only. QC must
  never become a new way for the pipeline to fail.
- The plan was to wait until enough reviewed drafts showed which failures actually recur.

---

## 17. AI provider layer and routing

**Many providers, configured as data.** Which provider and model handles which task, for which
creator, is set in the database, not in code, and changes without a redeploy.

- **Providers registered:** Anthropic, OpenAI, Google Gemini, Moonshot, DeepSeek, Qwen, xAI Grok,
  Manus (registered but unused, since its API shape wasn't verified) and Tavily (search only).
  Five adapters cover them, because several providers share an OpenAI-compatible API.
- **Task types:**
  - in use: interview, discovery, research, web search, scoring, angles, outline, article,
    quality check, image concepts, image, X shortening, LinkedIn shortening, translation,
    profile refinement;
  - routing-ready only: voice, video, code snippets.
- **Routes:**
  - each task type has a global default route, plus optional per-creator overrides;
  - each route names a provider, model and settings, with fallbacks in priority order;
  - on authentication, quota, rate-limit, timeout or server errors, the next fallback is tried.
- **Default routes:**
  - large tier (Claude Sonnet-class): article, angles, translation, discovery;
  - small tier (Claude Haiku-class): scoring, shortening, interview, outline, checks;
  - OpenAI's image model for hero images;
  - an OpenAI model as a fallback on most tasks.
- **Model registry:** the allowed models per provider, with capabilities and unit prices
  (including cached-token prices), used to validate routes and compute cost.
- **Health checks:** an admin can test any route on demand, and enabled routes are tested daily.
  Results are stored as readable messages, e.g. "Authentication failed — the OpenAI key is invalid;
  rotate the secret and re-test". A primary route that fails twice alerts the admin.
- **Platform-owned keys only.** Creators never supply or see provider keys ("bring your own key"
  was ruled out).
- **Prompts** are composed from blocks per run: editorial rules, voice, audience, mood, guardrails,
  few-shot examples, then the topic brief. The stable parts come first so prompt caching works.
  Every prompt has a version number, recorded on the published post.

---

## 18. Cost, budgets and limits

- **Global hard cap: US$20 per month.** Once it is reached, every AI call is refused. Alerts go
  out at 80% and 100%.
- **Per creator, by default:**
  - US$10 per month;
  - 2 runs per day;
  - a per-minute request limit.

  An admin can change these. Alerts at 80% and 100% go to the creator and the admins.
- **Four layers of enforcement:**
  1. Cloudflare AI Gateway's own cap;
  2. the in-app global cap, checked before every call;
  3. the per-creator check;
  4. limits on each call (maximum tokens, maximum searches, one image per article).
- **Metering.** Every AI call is recorded with the creator, task, provider, model, units and cost.
  The admin sees spend broken down by creator, provider, task, model and how the run ended,
  including **cost per published article**.
- **Errors are always readable,** never silent. For example: "Monthly AI budget ($10) reached —
  resets Aug 1."

---

## 19. Operational controls

- **Three independent kill switches,** each checked at the point where it takes effect:
  - **AI paused** stops every AI call, including in runs already under way;
  - **publishing paused** stops anything going live, while drafting continues;
  - **runs paused** stops new runs, while runs under way finish.

  Checking only when a run starts was rejected, because a run can wait at approval for days and
  publish long after someone pressed pause.
- **Suspending a creator** is reversible and separate from the budget: no runs, no spending, and
  login is refused with a reason.
- **Switches are a declared, typed set.** Defaults live in code, with database overrides on top,
  so a malformed setting can't change behaviour silently.
- **Every change to a switch or cap** goes into an **append-only audit trail**: who, what, old and
  new value, and when.
- An admin's route tests bypass the AI pause and the global cap; nothing else does.

---

## 20. Admin dashboard (web)

The dashboard has these views:

- **Monitor:** spend, cap status, route health, run statistics and the kill-switch panel.
- **AI routes:** create and edit routes, with a test button per route.
- **Models registry.**
- **Per-creator limits,** including the auto-publish toggle (refused for medical profiles, and
  audited).
- **Users:** create, suspend, reactivate and erase creators, and set each creator's site URL.
- **Budget breakdown.**

A cross-creator "run explorer" was deferred. The dashboard has no backend of its own; it uses the
same API as the app with admin rights.

---

## 21. Mobile app (Flutter, creators only)

**Screens:**
- login
- the drafts queue
- draft detail and review: article, hero image, derivatives, quality findings, compliance
  checklist, and the approve, revise, change-angle and reject dialogs; on a published draft, the
  social panel with Post and Retry
- the runs list
- run detail, which renders whichever gate the run is waiting on
- Generate with a mood picker
- My-topic request
- the profile page: writing, topics, publishing and connected accounts
- My data

**Notes:**
- The app is a thin client with minimal local state. It talks only to the backend, never directly
  to an AI provider or Sanity.
- It targets iOS and Android. The web build is for development only.
- **Push notifications:** draft ready, input needed, reminders, run failed, budget alerts,
  LinkedIn expiry, a failed auto post, and a nudge after 7 days of silence ("tap to get a draft
  on what's trending").

---

## 22. Data the system holds, retention and privacy

**Kept:**
- users and login sessions;
- profile versions;
- onboarding transcripts (30 days, then purged);
- runs;
- topic candidates with their scores and rejection reasons;
- drafts, where the Markdown is kept only until publish or reject;
- derivatives and their outcomes;
- revision instructions and edit diffs;
- gate choices, as a preference log;
- fetched sources;
- quality findings;
- the spend ledger;
- AI routes and health-check history;
- limits;
- switches and their audit trail;
- connected social accounts (tokens encrypted);
- social post records.

**Not kept:**
- the article body after publishing (Sanity holds the only copy);
- social passwords, ever;
- any patient data.

**Erasing a creator:**
- deletes all of their personal records;
- anonymises their spend records, so the accounting still adds up;
- leaves any published content in place (whether it stays up is an editorial decision).

---

## 23. Security summary

- **Secrets:** every secret lives server-side as a Cloudflare secret and is never in the app or
  the repository. Secrets can be rotated without code changes, following a runbook procedure, at
  least every 6 months.
- **Login:** email and password. Access tokens last 15 minutes and refresh tokens 30 days; refresh
  tokens are stored hashed and replaced on every use.
- **Isolation:** every query is scoped to the logged-in creator.
- **Logs** have credentials stripped out before anything is written, and a test enforces this.
- **Webhooks** are verified with an HMAC signature.
- **Social access** is OAuth only, with tokens encrypted at rest.

---

## 24. Architecture and technology, in prose

- **One backend:** a single **Cloudflare Worker** in TypeScript. It is a modular monolith with
  bounded-context modules: profiles, discovery, generation, publishing and social. The modules
  talk through in-process interfaces, never over the network. The REST API uses Hono.
- **Pipeline:** each run is a **Cloudflare Workflow**, a durable, step-by-step execution that can
  wait for an event (a gate answer) for long periods. Scheduled jobs use Cron Triggers:
  - daily: the dispatcher for autoRun creators, reminders, route health and purges;
  - hourly: the scheduled publisher;
  - weekly: a Sanity backup export.
- **Database:** **Neon PostgreSQL**, reached through Cloudflare Hyperdrive, with Drizzle as the
  data-access layer. Reads and writes are separated per module, in the spirit of CQRS.
- **AI:** an internal AI router (§17). Calls go out through Cloudflare AI Gateway for the
  providers it supports.
- **Content:** Sanity, with one project per creator.
- **Clients:** a Flutter app for creators and a React/Vite web dashboard for admins. Push
  notifications go through Firebase Cloud Messaging.
- **Backups:** point-in-time recovery on Neon, and a weekly Sanity export to Cloudflare R2.
- **Monorepo:** backend, admin and a shared package of schemas and types are TypeScript
  workspaces. Flutter has its own toolchain and talks to the backend through the REST API.

---

## 25. Environments, operations and testing

- **Environments:**
  - **staging** writes hidden Sanity drafts only and never publishes;
  - **production**, live since 2026-08-22, is the only environment that publishes and runs
    scheduled jobs.
- **CI:** on merge, CI typechecks, runs the tests, migrates the staging database and deploys
  staging. Production deploys are explicit. Database migrations always run through tooling, never
  by hand.
- **Tests** run against real PostgreSQL compiled to run in-process (not mocks). End-to-end
  pipeline tests use a fake workflow runtime and assert the "one paid call per step" rule.
- **Prompt changes** are meant to pass a small "golden set" regression (e.g. "contains the
  disclaimer", "X text ≤ 280 characters") before deploy.

---

## 26. Status: built, not built, known gaps

**Built and live:**
- the full v2 pipeline with all gates;
- hero images, derivatives and translation;
- approval, revision, rejection, scheduling and retraction;
- publishing to both sites;
- the admin dashboard, budgets, kill switches, suspension and audit;
- the profile page and My data;
- mood;
- connecting X and LinkedIn, and posting to them (LinkedIn verified; X blocked by a 403).

**Not built:**
- conversational onboarding (the endpoints are placeholders);
- the profile feedback/refinement loop (the signals are stored but unused);
- few-shot examples from approved posts;
- the Sanity webhook (publish confirmation and capturing Studio edits);
- a metrics view for creators;
- the Phase 5 QC layer;
- the run explorer for admins;
- voice, video and code-snippet features.

**Operational loose ends:**
- staging shares the production database (a dedicated branch is still needed);
- the R2 backup bucket is not enabled, so the weekly export logs an error;
- the backup restore rehearsal hasn't been done;
- X's write permission or plan is unconfirmed;
- many feature branches are stacked locally and not pushed.

---

## 27. Constraints likely to survive a redesign

These are stated rules or hard realities, not just past choices. Please confirm each one with me
before you rely on it.

- **Medical safety:** the guardrails, mandatory human approval, no patient data, and no connection
  to hospital systems.
- **No social passwords,** ever. Social access is OAuth only.
- **Each creator publishes to their own existing Sanity site.**
- **Hard spending limits** that the app itself enforces.
- **Never hard-code a user:** adding a creator is data, not code.
- **Platform realities:**
  - LinkedIn won't let a standard app comment, and its tokens last about 60 days;
  - X needs a paid plan that allows writes;
  - Sanity's rich-text format shouldn't be generated by the AI.
- **The owner's engineering conventions:** clean modular boundaries, domain-driven design, typed
  IDs, small single-purpose files, and established conventions.

---

## 28. Past decisions and the alternatives rejected

| Topic | Decision | Rejected or superseded |
|---|---|---|
| Users | A prototype for 2 users, ready for N | Full multi-tenant infrastructure now |
| Stack | TypeScript on Cloudflare Workers | C#/ASP.NET Core on Azure or a VPS; C# on Cloudflare |
| Architecture | Modular monolith in one Worker | Microservices; one Worker per module |
| Database | Neon Postgres | Cloudflare D1 (SQLite) |
| Discovery | LLM with web search | Dedicated integrations (HN, PubMed, RSS, Reddit); Google Trends |
| Language | A primary language plus opt-in translation | One "bilingual" setting |
| Approval | Required for both creators; auto-publish is admin-only, with conditions, and never for medical | Fully automatic publishing |
| Format | Long-form articles, 800–1,500 words | Short posts only (may come later per profile) |
| Sanity | One project per creator; the existing blog types are extended | One shared project; separate staging datasets |
| AI providers | Many providers, configured as data, platform-owned keys | A single provider; creators bringing their own keys |
| Budget | $20 global / $10 per creator | — |
| Runs (v1 → v2) | Started by the creator; cron only when opted in | A daily cron for everyone |
| Pre-draft control | Optional ask/auto gates at topic, angle, outline, image, derivatives, publish | Choosing the angle only on My-topic runs |
| Derivatives | Generated after approval, only the ticked ones | Generating everything before review |
| Draft expiry | Never expires; reminders instead | Expire after 7 days |
| Pending drafts | Pause new runs at 1 pending draft | At 2 |
| Kill switches | Three, each checked where it takes effect | One flag checked only when a run starts |
| QC | Advisory, falling back to deterministic checks, never blocking | Blocking QC |
| Social | Post directly; text only, with the link as a reply (X) or last line (LinkedIn) | Manual copy-paste; link as the first comment on LinkedIn; uploading images |
| Mood | Per article, with `critical` blocked for medical | `angry`; mood as a profile field |
| Admin UI | A separate web dashboard | Admin screens inside the Flutter app |

---

## 29. Observations for the redesign

These are the developer assistant's own observations, written for discussion and not as
conclusions.

- **Heavy for two users.** The system has 9 AI providers, about 19 task types, 4 layers of budget
  enforcement, 3 kill switches, a typed flag store with an audit trail, and 7 gates. All of that
  serves two people spending at most $20 a month.
- **The core value isn't proven yet.** The project started by treating "is the content good
  enough in my voice?" as the biggest risk. Yet the parts that most directly improve voice and
  quality aren't built: learning from edits, few-shot examples from approved posts, onboarding,
  and real QC. Most of the effort went into control, safety and operations.
- **Too many decisions per article.** A guided run asks up to 7 decisions. Every new requirement
  added a gate or a setting, so the gates may feel like friction rather than control. It's worth
  asking which ones the creators actually use.
- **The documents carry a lot of history.** Many paragraphs are corrections and "revised on" notes.
  A redesign could start from a short, current statement of intent.
- **Unconfirmed assumptions:**
  - Do the creators want trend discovery at all, or mostly their own topics?
  - Is the article the main product, or are the social posts?
  - Is a mobile app needed, or would a web app (or even a chat interface) do?
  - Does the medical creator's workflow differ enough to need its own design?

---

## 30. Questions worth brainstorming

1. Who is this really for in a year: the same two people, a small group, or a product for other
   creators? The answer changes tenancy, onboarding, billing and positioning.
2. What is the main output: a long-form article on the creator's site, social posts, or both
   equally?
3. How much control does a creator want: one tap ("write me something good"), or several
   choices along the way? Could the gates collapse into fewer, smarter steps?
4. How should the system learn a creator's voice over time, and how will we know it's working?
5. What is the simplest design that keeps the medical safety guarantees?
6. What should the app's main screen be: a queue of drafts, a conversation, a content calendar?
7. Which operational machinery is essential at this scale, and which can wait?
8. Is the current stack (Cloudflare Workers + Workflows, Neon, Flutter, Sanity) still right, or
   would a different shape be simpler to build and change?
9. Which features should be cut entirely?
10. What should be measured to judge success: published articles per month, approval without
    edits, time spent per article, audience engagement?
