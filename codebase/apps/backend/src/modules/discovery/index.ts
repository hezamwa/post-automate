// Bounded context: discovery (AR-10.2) — LLM-with-search discovery, targeted research,
// scoring. All AI calls go through the router (AR-10.9); prompts live in workflows/prompts.
import { and, eq, gte } from "drizzle-orm";
import type { Profile } from "@post-automate/shared";
import { toChatRequest } from "../../ai/prompts/spec";
import { hasRouteFor, runSearch, runTask } from "../../ai/router";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { buildResearchPrompt } from "../../workflows/prompts/research";
import { buildScorePrompt } from "../../workflows/prompts/score";
import { buildSynthesizeCandidatesPrompt } from "../../workflows/prompts/synthesize-candidates";
import type { CandidateRef, FetchedResult, TopicBrief } from "./types";

export type { CandidateRef, FetchedResult, TopicBrief } from "./types";

interface RunCtx {
  userId: string;
  runId: string;
  profile: Profile;
}

/** Titles the user covered (selected candidates) in the last `days` — the FR-5.7 exclusion window. */
export async function recentTopicTitles(db: Db, userId: string, days = 30): Promise<string[]> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await db
    .select({ title: schema.topicCandidates.title })
    .from(schema.topicCandidates)
    .where(
      and(
        eq(schema.topicCandidates.userId, userId),
        eq(schema.topicCandidates.selected, true),
        gte(schema.topicCandidates.createdAt, cutoff),
      ),
    );
  return rows.map((r) => r.title);
}

export interface TopicRequestWarnings {
  /** Banned topics the request collides with — blocks unless explicitly overridden (FR-7.7). */
  bannedCollisions: string[];
  /** Similar topics covered in the last 30 days — informs, never blocks (FR-5.7/7.7). */
  similarRecentTopics: string[];
}

/**
 * FR-7.7 pre-flight for user-requested topics, run in code BEFORE the workflow starts
 * (design §6): a banned-topic collision warns and requires overrideBannedTopics: true on
 * resubmit; the 30-day dedup only informs. Matching is deliberately plain substring
 * containment, case-insensitive — the hard compliance net stays in the generation
 * guardrails (FR-6.6-6.8), which apply regardless of topic origin.
 */
export async function checkTopicRequest(
  db: Db,
  profile: Profile,
  userId: string,
  topic: { title: string; notes?: string },
): Promise<TopicRequestWarnings> {
  const haystack = `${topic.title} ${topic.notes ?? ""}`.toLowerCase();
  const bannedCollisions = profile.topicPolicy.bannedTopics.filter((banned) =>
    haystack.includes(banned.toLowerCase()),
  );
  const title = topic.title.toLowerCase();
  const similarRecentTopics = (await recentTopicTitles(db, userId)).filter((recent) => {
    const r = recent.toLowerCase();
    return r.includes(title) || title.includes(r);
  });
  return { bannedCollisions, similarRecentTopics };
}

/**
 * Fetch real results when a 'web_search' route is configured, so the chat model synthesises
 * from them instead of searching for itself (FR-5.4). No route = the LLM-native path,
 * unchanged. A search that fails is not fatal: falling back to LLM-native search produces a
 * worse brief, never no brief.
 */
async function fetchResults(env: Env, db: Db, ctx: RunCtx, query: string): Promise<FetchedResult[] | undefined> {
  if (!(await hasRouteFor(db, "web_search", ctx.userId))) return undefined;
  try {
    const { results } = await runSearch(env, db, {
      userId: ctx.userId,
      runId: ctx.runId,
      query,
      count: 10,
      freshness: "week",
    });
    return results.length > 0 ? results : undefined;
  } catch (e) {
    console.log("discovery: web_search route failed, falling back to LLM-native search", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** FR-5.4: LLM + web search returns candidates; all are persisted (DR-9.3). */
export async function findTopics(env: Env, db: Db, ctx: RunCtx): Promise<CandidateRef[]> {
  const recentTopics = await recentTopicTitles(db, ctx.userId);
  const fetched = await fetchResults(env, db, ctx, `latest news and discussion in ${ctx.profile.domain.subNiches.join(", ")}`);
  const result = await runTask(env, db, {
    taskType: "discovery",
    userId: ctx.userId,
    runId: ctx.runId,
    // The model only searches when nothing was fetched for it — never both, which would
    // bill two searches for one brief.
    input: toChatRequest(buildSynthesizeCandidatesPrompt({ profile: ctx.profile, recentTopics, fetched }), { webSearch: !fetched }),
  });
  const { candidates } = result.parsed as { candidates: TopicBrief[] };
  const refs: CandidateRef[] = [];
  for (const c of candidates) {
    const [row] = await db
      .insert(schema.topicCandidates)
      .values({
        runId: ctx.runId,
        userId: ctx.userId,
        source: "discovered",
        title: c.title,
        summary: c.summary,
        sourceUrls: c.sourceUrls,
      })
      .returning({ id: schema.topicCandidates.id });
    refs.push({ id: row!.id, ...c });
  }
  return refs;
}

/** FR-5.2: score every candidate, persist scores + rejection reasons, select the winner (≥6). */
export async function scoreAndSelect(
  env: Env,
  db: Db,
  ctx: RunCtx,
  candidates: CandidateRef[],
): Promise<CandidateRef | null> {
  const result = await runTask(env, db, {
    taskType: "scoring",
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(buildScorePrompt({ profile: ctx.profile, candidates })),
  });
  const { scores } = result.parsed as {
    scores: Array<{ index: number; score: number; reason: string }>;
  };

  let best: { candidate: CandidateRef; score: number } | null = null;
  for (const s of scores) {
    const candidate = candidates[s.index];
    if (!candidate) continue;
    await db
      .update(schema.topicCandidates)
      .set({ score: String(s.score), rejectionReason: s.reason })
      .where(eq(schema.topicCandidates.id, candidate.id));
    if (s.score >= 6 && (!best || s.score > best.score)) best = { candidate, score: s.score };
  }
  if (!best) return null;
  await db
    .update(schema.topicCandidates)
    .set({ selected: true, rejectionReason: null })
    .where(eq(schema.topicCandidates.id, best.candidate.id));
  return best.candidate;
}

/** FR-5.8: targeted research for a user-chosen topic — replaces discover+score. */
export async function researchTopic(
  env: Env,
  db: Db,
  ctx: RunCtx,
  userTopic: { title: string; notes?: string; links?: string[] },
): Promise<CandidateRef> {
  const fetched = await fetchResults(env, db, ctx, userTopic.title);
  const result = await runTask(env, db, {
    taskType: "research",
    userId: ctx.userId,
    runId: ctx.runId,
    input: toChatRequest(buildResearchPrompt({ profile: ctx.profile, topic: userTopic, fetched }), { webSearch: !fetched }),
  });
  const brief = result.parsed as TopicBrief & { keyFacts: string[] };
  const summary = `${brief.summary}\n\nKey facts:\n- ${brief.keyFacts.join("\n- ")}`;
  const [row] = await db
    .insert(schema.topicCandidates)
    .values({
      runId: ctx.runId,
      userId: ctx.userId,
      source: "user",
      title: brief.title,
      summary,
      sourceUrls: brief.sourceUrls,
      selected: true,
    })
    .returning({ id: schema.topicCandidates.id });
  return {
    id: row!.id,
    title: brief.title,
    summary,
    whyItMatters: brief.whyItMatters,
    sourceUrls: brief.sourceUrls,
  };
}
