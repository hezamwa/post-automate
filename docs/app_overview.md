This maps well onto your existing stack, so I'll anchor recommendations to C# DDD/CQRS + Flutter + Sanity and flag decisions you need to lock down as we go.

## 1. User onboarding & profile building

With exactly two known users, you don't need self-serve registration — seed both accounts and skip email verification, password reset flows, etc. entirely. What you *do* need is a rich, structured **Creator Profile** that becomes the input to every downstream prompt. I'd model it as an aggregate in a `Profiles` bounded context:

- **Identity**: user ID, display name, Sanity author reference
- **Domain**: tech vs medical, plus sub-niches (e.g., "AI tooling, mobile dev" vs "cardiology, public health")
- **Voice**: tone descriptors, formality level, sentence length preference, emoji/hashtag policy, hook style
- **Audience**: who they write for, expertise level assumed
- **Topic policy**: interests (weighted), explicit exclusions/banned topics — critical for the medical user
- **Cadence**: posts per week, preferred publish times
- **Language**: this matters for you — Arabic-only, English-only, or bilingual per post?

Store the profile as versioned records, not mutable state — when personalization drifts, you'll want to diff versions against content quality.

**Clarifying questions:** Is this permanently two users, or a prototype for a multi-tenant product later (changes auth and tenancy decisions now)? Bilingual content or single language per user? Should the medical user's profile carry compliance constraints (e.g., "never give dosage advice, always add a disclaimer")?

## 2. Conversational AI onboarding flow

Treat the chat as a **structured extraction exercise**, not open-ended conversation. The backend drives it:

1. Flutter renders a chat UI; every turn goes to your C# API, which calls the LLM with a system prompt defining the interview goal and the target profile JSON schema.
2. Use **structured outputs / tool calling** so each turn the model returns two things: the next question to ask, and the partially-filled profile object. Your backend merges the partial profile into session state.
3. When all required fields are populated, the model produces a summary ("Here's how I understand your voice…") and the user confirms or corrects before the profile is persisted.
4. Cap it at ~8–12 questions. Beyond that, onboarding fatigue kills quality answers.

One important addition: ask each user to paste 2–3 examples of posts they've written or admire. Those become few-shot examples in the generation prompt — this does more for voice matching than any adjective-based tone description.

**Clarifying questions:** Should users be able to re-run onboarding later to update their profile, or edit fields directly in a settings screen (I'd do both — chat for initial, form for tweaks)? Which model for the interview — you could use a cheaper model (Haiku-class) here and reserve the stronger model for content generation.

## 3. Backend architecture & API selection

Your DDD/CQRS instincts fit, but for a two-user app I'd build a **modular monolith**, not microservices: one ASP.NET Core service with four bounded contexts — `Profiles`, `Discovery`, `Generation`, `Publishing` — communicating via in-process domain events. Add **Hangfire** (or Quartz.NET) for scheduled pipeline runs. EF Core for writes, Dapper for reads, matching your existing patterns.

The pipeline per run: `Discover topics → Score/filter against profile → Generate draft → (optional approval) → Publish to Sanity → Record outcome`.

**API selection is the biggest open decision:**

- **Content generation**: Claude API or OpenAI. Given you're already deep in the Anthropic ecosystem, Claude Sonnet-class is a sensible default — strong Arabic support if you go bilingual.
- **Tech topic discovery**: Hacker News API (free, excellent signal), Reddit API, GitHub trending (scrape or unofficial APIs), RSS feeds from key blogs. Google Trends has no official API — pytrends-style scraping is fragile; I'd avoid depending on it.
- **Medical topic discovery**: PubMed E-utilities (free, official) for new research, plus WHO/CDC RSS feeds, and Reddit medical communities for "what people are asking." Medical trending is fundamentally different from tech trending — recency of *research* vs recency of *buzz*.
- A pragmatic alternative: use an LLM with web search as the discovery layer itself ("find 10 trending topics in X this week, return JSON"), which collapses several API integrations into one. Less control, much faster to ship.

**Clarifying questions:** Where does this host — Azure (fits your Microsoft stack) or something cheaper like a VPS? What's your monthly API budget ceiling — that decides between free sources (HN, PubMed, RSS) and paid ones (NewsAPI, X API, Exploding Topics)? Do you want the LLM-with-search shortcut for v1, or purpose-built discovery integrations?

## 4. Content personalization strategy

Build prompts as **composed templates**, assembled per run:

```
System prompt = base editorial rules
              + profile.voice (tone, structure, language)
              + profile.audience
              + few-shot examples (2–3 approved past posts)
              + domain guardrails (medical disclaimers, banned topics)
User prompt   = topic brief (title, why trending, source links, angle)
```

Two things make or break this. First, the **few-shot examples**: rotate in the user's most recently *approved* posts so the voice adapts over time. Second, a **feedback loop**: when a user edits a draft before approval, store the diff. Periodically feed edits back ("the user consistently shortens intros — adjust") either manually into the profile or via an automated profile-refinement job.

Also generate a **topic angle** step separately from the draft step (two LLM calls): first "given this trending topic and this profile, propose 3 angles," pick one (automatically or by user), then generate. Quality jumps significantly versus one-shot generation.

**Clarifying questions:** Fully automated posting, or human-in-the-loop approval (push notification → review draft in app → approve/edit/reject)? For the medical user I'd strongly argue approval is non-negotiable. What content format — long-form articles, short posts, or both? Target length per post?

## 5. Sanity integration

You know this terrain. The design decisions:

- **Publish as drafts, not published documents**, at least initially — use the Mutations API to create `drafts.` documents, and let approval (in your app or Sanity Studio) trigger publish. This gives you a safety net for free.
- **Schema**: a `post` document with author reference, body (Portable Text), topic tags, plus a `generationMeta` object — model used, prompt version, source URLs, pipeline run ID. That metadata is gold for debugging "why did it write this."
- **Portable Text conversion**: generate Markdown from the LLM, convert to Portable Text server-side (there are .NET-side options, or a small Node conversion step). Don't ask the LLM to emit Portable Text JSON directly — it will produce malformed blocks.
- Use a **write-scoped token per environment**, stored server-side only. Consider separate datasets for staging vs production content.

**Clarifying questions:** One Sanity project/dataset shared by both users, or separated? Draft-first with approval, or straight publish once you trust the pipeline? Do you want Sanity webhooks flowing back to your backend (e.g., to confirm publish, track edits made in Studio)?

## 6. Data storage

Clear division of ownership: **Sanity is the source of truth for content; your database is the source of truth for pipeline state.** In PostgreSQL or SQL Server:

- Profiles (versioned), onboarding transcripts
- Topic candidates per run (with scores and rejection reasons — invaluable for tuning)
- Pipeline runs and their state machine (discovered → drafted → pending-approval → published/failed)
- Edit diffs and approval decisions for the feedback loop

Don't duplicate full post bodies in your DB after publish — store the Sanity document ID and fetch when needed. On the Flutter side, minimal local state; this app is thin-client, the backend does everything.

**Clarifying question:** Any retention constraints — e.g., should onboarding transcripts (which may reveal the medical user's professional details) be purged after profile extraction?

## 7. Security considerations

- **All API keys live server-side only** — Anthropic/OpenAI, Sanity tokens, discovery APIs. The Flutter app talks exclusively to your backend. Never embed keys in the app binary; they're trivially extractable.
- **App ↔ backend auth**: with two users, a simple JWT flow is fine (or Firebase Auth if you want the plumbing done for you). No need for full identity infrastructure.
- **Secrets management**: Azure Key Vault or equivalent, injected at runtime — not appsettings in the repo.
- **Medical content is the real risk surface.** This is YMYL territory: hard-code guardrails in the generation prompt (no diagnosis, no dosages, mandatory disclaimer block), keep human approval mandatory for that user, and ensure nothing resembling patient data ever enters the pipeline. Given your KSMC context, keep this project fully separate from any hospital systems and data.
- Rate-limit and cap pipeline spend (max tokens per run, max runs per day) so a scheduling bug doesn't burn your API budget overnight.

**Clarifying question:** Will the medical user's content ever reference real cases or institutional information? If there's any chance, you need an explicit content policy checked at generation and approval time.

## 8. Phased rollout

- **Phase 1 — Manual pipeline, one user (2–3 weeks):** Backend only. Hard-code your own profile, trigger the pipeline via an endpoint, publish drafts to Sanity, review in Studio. No Flutter yet. This validates the hard part — discovery quality and voice matching — before you invest in UI.
- **Phase 2 — Approval loop + Flutter shell:** Basic app with login, a drafts queue, approve/edit/reject. Add the second (medical) user with a hand-written profile and the medical guardrails.
- **Phase 3 — Conversational onboarding:** Build the chat-driven profile builder, re-onboard both users through it, compare output quality against the hand-written profiles.
- **Phase 4 — Automation + feedback:** Hangfire scheduling, push notifications on new drafts, edit-diff capture, profile refinement, and a small metrics view (topics surfaced, approval rate, edit distance).

This ordering front-loads risk: if generated content quality isn't good enough in Phase 1, you've learned that in weeks without building an app around it.

The five decisions I'd lock down first, since everything else hangs off them: **approval-required vs fully automatic** (per user), **discovery approach** (LLM-with-search vs dedicated APIs), **language strategy** (Arabic/English/bilingual), **hosting target**, and **content format/length**. Answer those and I can turn this into a concrete spec with the profile JSON schema, prompt templates, and the pipeline state machine.