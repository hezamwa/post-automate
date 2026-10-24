# post-automate — Redesign Design Brief

A clean statement of the redesigned product, written from the brainstorm of 23–24 October 2026. It replaces the previous brief and carries no history. Open items are listed at the end.

## 1. Why the redesign

- Since production went live on 22 August 2026, Waleed published fewer than 10 articles and Afnan published none.
- Afnan never tried the app: it wasn't easy to get onto her phone, and the frontend had too many confusing steps.
- The owner is not satisfied with any part of the current app.
- Draft problems, worst first:
  1. Made-up facts about the creator (e.g. an invented personal anecdote).
  2. Doesn't sound like the creator: high-level, AI-sounding.
  3. Drifts from what was asked.
  4. Longer than the creator would write or read.
  5. Revising means rewriting the whole draft, which costs too much.
- V1 topic suggestions often fell outside the creator's field, and the settings steering them weren't visible in the app.

## 2. Success criteria

Three months after release 1, the redesign succeeds if:

| Goal | How it is measured |
| --- | --- |
| Afnan uses it without asking for help | Her pieces per month; times she needed help |
| Zero invented facts | Unsupported claims at publish time = 0; post-publish "this is wrong" flags |
| Simple, engaging pieces | Readability per audience; engagement on LinkedIn/X and the site |
| Variety of piece types | Number of distinct types published per month |
| Cost-effective AI with control | Cost per published piece, by mode, type and step |

## 3. Users

- **Waleed:** tech creator and admin. Writes in English.
- **Afnan:** medical creator (YMYL content, strict guardrails). iPhone user.
- Adding a creator is data, never code.
- Both creators have very little existing public writing, so voice must be built going forward.
- Both prefer speaking to writing; voice input is in English.

## 4. Core product concepts

- **Piece:** one unit of content, with a set of outputs.
- **Outputs:** website article (Sanity), LinkedIn post, X post. Article and social posts are equally important.
- **Standalone posts:** LinkedIn and X posts are complete pieces with their own hook and value, never summaries of the article. The link is a bonus.
- **Post-only pieces** (no article) are a normal option.
- **Type:** what kind of content it is (§5). Chosen first.
- **Mode:** how much collaboration it takes (§6).
- **Language:** chosen per piece up front; the piece is written directly in that language. There is no translation step.

## 5. Piece types (Catalog)

Types are data, editable without code. Each type carries: description, structure, default mode, default length, default channels, prompt blocks and grounding rules.

| # | Type | Description | Default mode | Article length |
| --- | --- | --- | --- | --- |
| 1 | Occasion | Marking a national day, holiday or awareness day | Post | — |
| 2 | Promotion | Announcing or recommending a product, service, event or offer | Post or Quick | \~300 words |
| 3 | News Reaction | Your take on something that just happened | Quick | 400–600 |
| 4 | Weekly Roundup | Several notable items with short comments | Quick | 500–700 |
| 5 | Worth Sharing | An idea, tool or article you came across, and why it matters | Quick | 300–500 |
| 6 | Explainer | Helping people understand a concept or clear up a myth | Deep | 700–1,000 |
| 7 | Study Breakdown | A new study or guideline explained simply | Deep | 600–900 |
| 8 | How-To | Steps or tips to get something done | Deep | 700–1,200 |
| 9 | Opinion | A clear position with your arguments | Deep | 600–900 |
| 10 | Review | A verdict on one thing, or a comparison of options | Quick or Deep | 600–900 |
| 11 | My Story | A milestone, good news at work or in life, an event attended, a lesson learned | Quick | 400–700 |
| 12 | Ask the Audience | A short question to start a discussion | Post | — |

**Default channels:**

- All three (article, LinkedIn, X): News Reaction, Explainer, Study Breakdown, How-To, Opinion, Review.
- LinkedIn first, X optional, no article: Occasion, Ask the Audience, Promotion.
- LinkedIn and article, X optional: My Story, Worth Sharing.
- Article first with a short social teaser: Weekly Roundup.

**Grounding rules by type (examples):**

- My Story, Occasion: personal content only from the creator's take and facts; no invented experiences.
- Promotion: product claims only from what the creator supplied; promotional content clearly marked.
- News Reaction, Worth Sharing: event facts from the shared source, with attribution.
- Explainer, Study Breakdown, How-To: every factual claim sourced; for medical, authoritative sources only.
- Opinion: opinions are the creator's, facts are sourced, and the two are kept apart.

Rarer kinds (case study, predictions, interviews, hiring, appreciation) fit under existing types for now and can be added later as data.

## 6. Modes

A mode is an ordered list of step kinds, run by one shared engine.

| Step kind | Post | Quick | Deep |
| --- | :-: | :-: | :-: |
| Source / idea | ✓ | ✓ | ✓ |
| Settings (language, audience, mood, length, channels) | ✓ | ✓ | ✓ |
| Your take (optional) | ✓ | ✓ | ✓ |
| Angle |  |  | ✓ |
| Outline |  |  | ✓ |
| Write whole draft |  | ✓ |  |
| Write section by section |  |  | ✓ |
| Standalone posts | ✓ | ✓ | ✓ |
| Claim check | ✓ | ✓ | ✓ |
| Publish per channel | ✓ | ✓ | ✓ |

- Writing granularity is chosen per piece: section by section for Deep, the whole draft for Quick, and any section can still be rewritten on its own.

## 7. The creator's flow

**Entry points (home screen leads with "start something"):**

1. **I have an idea:** type or speak a topic or rough thought.
2. **React to a link:** paste a link, or share it from Safari, X or LinkedIn through the iOS Share Extension.
3. **Suggest something** (release 2): topic discovery, §11.

In-progress and recently published pieces appear below the entry points.

**Steps for every piece:**

1. **Type** (explicit, first).
2. **Mode**, preset by the type and changeable.
3. **Settings**, preset by type and profile, all visible and changeable.
4. **Your take:** text or voice, always optional. Voice is transcribed on-device, shown and editable, then tidied into points without losing the creator's phrasing.
5. Mode-specific steps (angle, outline, sections, or the whole draft).
6. **Standalone posts** for the selected channels.
7. **Claim check** (§9) over everything written: the article and every post.
8. **Publish per channel** (§10).

**Interaction rules:**

- Explicit choices up front, step by step, with a smart default preselected so agreeing costs one tap.
- Every step uses the same layout: options, a recommended one preselected, and a field for free text or voice.
- **No back-and-forth AI conversation.** Each step makes one paid AI call. When input is missing, the app shows a plain hint with no AI call.
- The creator's own words are kept verbatim and pinned to every generation step, to stop drift.
- Revisions are targeted: one section or one post at a time, never the whole piece.

## 8. Accuracy and voice

- **Facts** are the only source of personal claims, and they hold only claims about the creator, never general knowledge. Each is one short statement, marked **public** (usable in content) or **context only** (background, never written, e.g. Afnan's institution).
- **Voice** is built from the creator's own words: their take in each piece, onboarding answers, and every approved piece. Résumé text is never used as a voice sample.
- The AI never invents first-person experiences. If a type needs personal substance and none exists, the app asks for a note or link instead of inventing.

## 9. Claim check

- Runs after all outputs are written, so it covers the article and every post. In Post mode, it covers the posts alone.
- A cheap model extracts every factual claim from the draft and the posts.
- Each claim is labeled:
  1. **Sourced:** backed by a fetched source.
  2. **Yours:** from the creator's take or stored facts.
  3. **Opinion:** clearly a view.
  4. **Unsupported:** none of the above.
- Only doubtful matches are escalated to a stronger model.
- Each claim is also marked as **about the creator** (their experience, work, role) or **about the world** (everything else). The creator can correct this mark.
- **Approval is blocked** until every unsupported claim is removed, fixed, or confirmed:
  - **About the creator:** the creator confirms it, and it is saved as a new public fact, usable in future pieces.
  - **About the world:** the creator confirms it for this piece only. It is kept with the piece's claim check and is never saved as a fact.
  - **About the world, in a medical piece:** it can't be confirmed. It needs an authoritative source, or it is removed.
- Any section or post rewritten after the check is checked again before approval. Only the rewritten part is re-checked, not the whole piece.
- A claim-by-claim view (each claim beside its source passage) is available to everyone, and is the default review view for medical pieces.

## 10. Publishing

- Each approved output is published per channel: now, scheduled, or skipped.
- Defaults come from the profile, so the common case is one tap.
- **Dependency guard:** a social post linking to the article waits until the article is live. If the article fails, the post keeps waiting, or the creator chooses to post without the link.
- The approved content is frozen at approval. Editing a scheduled output replaces it explicitly.
- Retry re-runs only the failed channel, never duplicating. Retraction works per channel.
- **Sanity:** one project per creator, writing to each site's existing blog types with a field mapping. The AI writes Markdown; the server converts it to Sanity rich text.
- **LinkedIn and X:** OAuth only; tokens encrypted; text-only posts. X posting works today. LinkedIn tokens expire after about 60 days, with a reminder before expiry.

## 11. Topic discovery (release 2)

- Runs **only when the creator taps "Suggest something"**, never on a schedule.
- One snippet search plus one small-model call returns about five topics, each with a title, why it matters now, source links, and a **suggested type**.
- Searches are built from the creator's specific sub-niches; anything outside their fields is filtered out before scoring.
- Topics covered in the last 30 days are excluded.
- Each suggestion shows **why it was picked** (which interest it matched).
- A free "not my field" button adds an exclusion with no AI call.
- For medical creators, discovery uses research sources (PubMed, WHO, guideline bodies) instead of general buzz.
- Ported from V1's discovery logic, with candidates and scoring merged into one call.

## 12. Medical layer

Same app and flow, with these additions for medical profiles:

- Guardrails applied automatically: educational content only; no diagnosis, treatment advice or dosages; no real patients, cases or institutions; the exact disclaimer on every article.
- If a topic can't be covered within the rules, the step fails rather than producing a non-compliant draft.
- Authoritative sourcing (PubMed, WHO, CDC, guideline bodies).
- Human approval is always required.
- No connection to hospital systems and no patient data, ever.

## 13. Onboarding

One step, with no onboarding UI in the app:

1. The admin creates the creator, Sanity configuration and limits.
2. The creator runs a **standard interview prompt** in an external AI chat app, attaching their résumé for background.
3. The interview produces a **structured profile document**: identity and role, fields and sub-niches, audiences, default language, tone, topics to cover and avoid, facts (public or context only), verbatim answers as voice samples, preferred types, posting habits, and medical compliance where relevant.
4. The document is imported through the admin dashboard, validated, and confirmed by the creator in the app.
5. The creator connects LinkedIn and X in the app via OAuth. No passwords or tokens ever pass through the interview.

The interviewer prompt must record only what the person said, never embellish, and read facts back for confirmation.

## 14. Domain model

**Bounded contexts:**

| Context | Responsibility | Key concepts |
| --- | --- | --- |
| Creators | Who writes | Creator, Profile (versioned), Fact, VoiceSample, ConnectedAccount, SiteConfig, Compliance |
| Catalog | Kinds of content | PieceType, Mode, StepKind |
| Authoring (core) | Making a piece | Piece |
| Publishing | Getting outputs live | Publication |
| AI Gateway | Models, routing, money | Route, Model, Budget, UsageEntry |
| Observability | Knowing what's going on | Read models built from events |

**Piece aggregate:**

- Identity: PieceId, CreatorId, PieceTypeId, Mode, pinned profile version.
- Settings: language, audience, mood, length, selected outputs.
- Inputs: takes (text or voice transcript) and sources.
- Steps: step kind, status, options offered, choice made, free text. This is the future learning signal.
- Plan: angle and outline (Deep).
- Body: sections, each with revisions (AI version, edits, accepted).
- Posts: LinkedIn and X texts with revisions.
- Claim check: claims with their labels and sources.
- State: Setup → Writing → Review → Approved → Closed, or Abandoned.

**Publication aggregate** (one per piece per channel):

- Channel (Sanity article, LinkedIn, X), content snapshot frozen at approval, schedule, optional dependency on another publication, attempts with readable errors, external reference and public URL.
- Status: Scheduled → WaitingForDependency → Publishing → Published or Failed (retry) → Retracted.

**Creators rules:**

- Everything that steers the AI is visible to the creator.
- The profile is versioned and pinned per piece.
- Facts and voice samples live **outside** the versioned profile, so new facts are usable immediately, including in pieces already in progress.
- The admin can see everything in a creator's profile, including facts. Only the creator edits their own facts.

**Events:** PieceStarted, StepCompleted, DraftReady, PieceApproved, PublicationScheduled, PublicationSucceeded, PublicationFailed, AiCallMetered, BudgetThresholdReached. In-process within the modular monolith.

**Retention:** keep everything. Sanity owns the live version; the app owns the full history of how it was made (sections, revisions, claim checks, sources). Erasing a creator deletes their history.

## 15. AI execution, routing and cost

**Execution:**

- Every AI step runs as a background job, never inside the HTTP request.
- When the app is open, output streams live over Server-Sent Events; when it's closed, the result is saved and a push notification is sent.
- Results are stored per step and attempt, so a retry never pays twice.

**Starting tiers per step kind:**

| Step kind | Tier |
| --- | --- |
| Tidy voice transcript | Small |
| Fetch and summarise sources | Small |
| Angles | Large |
| Outline | Small, test Large |
| Write section or whole draft | Large |
| Rewrite one section | Large, one section only |
| Standalone posts | Medium/Large |
| Claim extraction and matching | Small, escalating doubtful claims to Large |
| Hero image | Image model |
| Speech-to-text | On-device (free) |

**Route resolution:** step kind plus optional domain, piece type and creator. Most specific wins, using fixed weights (creator 8, type 4, domain 2, default 0).

- A default route must exist for every step kind.
- Every AI call records which rule matched.
- The admin can preview the resolved model and estimated cost per piece before any spend.
- Start with defaults only; add overrides when evidence justifies them.
- Each rule has its own fallbacks.
- Each step kind has a small test set; cheaper models are tried first and promoted only when they fail it.

**Budget:** two layers, the AI Gateway hard cap and one in-app check (global and per creator) before every paid call. Per-call limits are plain constants. One "pause all" toggle.

## 16. Admin

Visibility first:

- Activity feed: who started what, which step each piece is at, what was published where.
- Spend per creator, per piece, per step.
- Errors in plain language (failed AI calls, failed posts, expiring tokens).
- Routes with an on-demand test button and route preview.
- Creators, profiles and limits.

Cut from the old system: three kill switches with audit trail, daily health checks, suspend/erase flows, autoRun.

## 17. Platform

- **Backend:** C# / ASP.NET Core on .NET 10, a modular monolith with Clean Architecture and DDD. EF Core, Hangfire for jobs and scheduled publishing, Server-Sent Events for streaming. Microsoft.Extensions.AI as the base for the AI router.
- **Hosting:** Oracle Cloud only, so everything is managed in one place. An Ampere A1 VM (Always Free allowance: 2 OCPUs, 12 GB), account converted to Pay As You Go on day one (prevents idle reclamation), with a budget alert. Docker Compose runs the API. The VM is stateless and disposable.
- **Database:** PostgreSQL for development. Production is not chosen yet; if it is PostgreSQL, it runs as a managed service, never on the VM. The database provider is switchable: engine-specific code and migrations live only in provider projects, chosen by configuration.
- **Mobile:** Flutter, iPhone first, distributed via TestFlight, with small native Swift pieces for the Share Extension and on-device speech. Android is not a priority.
- **Admin:** a standalone SPA in its own project, using an API client generated from the backend's OpenAPI document.
- **Deploy:** GitHub Actions builds an ARM64 image and the VM pulls it.
- **Ops:** unattended security upgrades, one free uptime check, secret rotation every 6 months.
- **Codebase:** same repo, with V1 kept in `archive/v1` for reference. Proven parts are copied from V1: Sanity field mapping, Markdown-to-rich-text conversion, LinkedIn and X OAuth, discovery logic and the hero image generator.
  - `codebase/backend`: the `WaleedAlHezam.PostAutomate` solution. A shared kernel and building blocks, then one project per module and layer (Domain, Contracts, Application, Infrastructure, Infrastructure.PostgreSql, Presentation). Seed data for the catalog and prompts.
  - `codebase/admin`, `codebase/mobile`, `codebase/deploy`.

## 18. Release plan

**Release 1:**

- All three modes and all twelve types.
- Entry points: I have an idea, React to a link (Share Extension).
- Text and voice input.
- Language chosen per piece.
- Facts store and blocking claim check.
- Article on Sanity, standalone LinkedIn and X posts, per-channel publishing.
- Hero image ported as-is.
- Learning signals stored from day one.
- Admin visibility views.

**Build order:** engine plus Post mode, then Quick, then Deep, using internal TestFlight builds at each stage. Afnan is invited when Deep is done, or earlier if it drags.

**Release 2:**

- Suggest something (topic discovery).
- Learning from edits (voice improvement loop).
- Hero image improvements.
- Sanity webhook to capture post-publish Studio edits.

## 19. Open items

- Write the onboarding interview prompt (needs Afnan's exact disclaimer text).
- Flutter screen structure (deferred by the owner).
- Prompt test sets and how a prompt change is verified before release.
- Remaining per-type fields: hero image use, call to action, hashtag policy.
- Detailed admin observability views.
- Production database (managed PostgreSQL or another managed engine).
- Whether "Oracle only" also covers DNS and ingress (instead of Cloudflare DNS and Tunnel), admin hosting and the container registry.
- Confirm whether either Sanity schema requires a hero image.
