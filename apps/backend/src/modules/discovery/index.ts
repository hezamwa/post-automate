// Bounded context: discovery (AR-10.2) — LLM-with-search discovery, targeted research,
// scoring. All AI calls go through the router (AR-10.9).
import { and, eq, gte } from "drizzle-orm";
import type { Profile } from "@post-automate/shared";
import { runTask } from "../../ai/router";
import {
  candidatesSchema,
  discoveryPrompt,
  researchPrompt,
  researchSchema,
  scoresSchema,
  scoringPrompt,
  type TopicBrief,
} from "../../ai/prompts/tasks";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";

export interface CandidateRef extends TopicBrief {
  id: string;
}

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

/** FR-5.4: LLM + web search returns candidates; all are persisted (DR-9.3). */
export async function findTopics(env: Env, db: Db, ctx: RunCtx): Promise<CandidateRef[]> {
  const recent = await recentTopicTitles(db, ctx.userId);
  const prompt = discoveryPrompt(ctx.profile, recent);
  const result = await runTask(env, db, {
    taskType: "discovery",
    userId: ctx.userId,
    runId: ctx.runId,
    input: {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      jsonSchema: candidatesSchema as unknown as Record<string, unknown>,
      webSearch: true,
      maxTokens: 16000,
    },
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
  const prompt = scoringPrompt(ctx.profile, candidates);
  const result = await runTask(env, db, {
    taskType: "scoring",
    userId: ctx.userId,
    runId: ctx.runId,
    input: {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      jsonSchema: scoresSchema as unknown as Record<string, unknown>,
      maxTokens: 3000,
    },
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
  const prompt = researchPrompt(ctx.profile, userTopic);
  const result = await runTask(env, db, {
    taskType: "research",
    userId: ctx.userId,
    runId: ctx.runId,
    input: {
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      jsonSchema: researchSchema as unknown as Record<string, unknown>,
      webSearch: true,
      maxTokens: 16000,
    },
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
