import { eq } from "drizzle-orm";
import { PROFILE_SCHEMA_VERSION, type Profile } from "@post-automate/shared";
import type { WorkflowStep } from "cloudflare:workers";
import { schema } from "../../src/db/client";
import { createRun } from "../../src/db/commands";
import { createRunContext, pinProfile, type PipelineParams, type RunContext, type UserTopic } from "../../src/workflows/context";
import { runPipeline } from "../../src/workflows/pipeline";
import { seedUser } from "../db/harness";
import { techProfile } from "../fixtures";
import { env, shared } from "./preamble";

// Seed helpers for workflow and step tests. Every creator gets a device token (so pushes
// are observable) and Waleed's Sanity project id (so the per-site mapper resolves).

export async function seedCreator(profile: Profile = techProfile()): Promise<string> {
  const userId = await seedUser(shared.db, { maxRunsPerDay: 10 });
  await shared.db
    .update(schema.users)
    .set({ fcmToken: "device-token", sanityProjectId: "r9zdt0s0" })
    .where(eq(schema.users.id, userId));
  await shared.db.insert(schema.profiles).values({
    userId,
    version: 1,
    status: "active",
    payload: profile,
    schemaVersion: PROFILE_SCHEMA_VERSION,
  });
  return userId;
}

export interface StartOptions {
  profile?: Profile;
  userTopic?: UserTopic;
}

/** A creator plus a run row, as /runs/trigger or /runs/request would create them. */
export async function startRun(opts: StartOptions = {}): Promise<PipelineParams> {
  const userId = await seedCreator(opts.profile);
  const run = await createRun(shared.db, {
    userId,
    trigger: opts.userTopic ? "user_topic" : "manual",
    profileVersion: 1,
    userTopic: opts.userTopic,
  });
  return { runId: run.id, userId, ...(opts.userTopic ? { userTopic: opts.userTopic } : {}) };
}

/** Drive the whole pipeline against the fake step. */
export function runWorkflow(params: PipelineParams): Promise<void> {
  return runPipeline(env, shared.step as unknown as WorkflowStep, params);
}

/** A context as steps see it after load-profile — for step unit tests. */
export async function stepContext(opts: StartOptions = {}): Promise<RunContext> {
  const params = await startRun(opts);
  const ctx = createRunContext(env, params);
  pinProfile(ctx, { version: 1, profile: opts.profile ?? techProfile() });
  return ctx;
}

export const runRow = (runId: string) =>
  shared.db.query.pipelineRuns.findFirst({ where: eq(schema.pipelineRuns.id, runId) });
export const draftRow = (runId: string) => shared.db.query.drafts.findFirst({ where: eq(schema.drafts.runId, runId) });
export const derivativeRows = (draftId: string) =>
  shared.db.select().from(schema.draftDerivatives).where(eq(schema.draftDerivatives.draftId, draftId));
export const revisionRows = (draftId: string) =>
  shared.db.select().from(schema.draftRevisions).where(eq(schema.draftRevisions.draftId, draftId));
export const candidateRows = (runId: string) =>
  shared.db.select().from(schema.topicCandidates).where(eq(schema.topicCandidates.runId, runId));

/** A pending draft row for the run, as save-draft would have written it. */
export async function seedDraftRow(
  params: PipelineParams,
  extra: Partial<typeof schema.drafts.$inferInsert> = {},
): Promise<string> {
  const [row] = await shared.db
    .insert(schema.drafts)
    .values({ runId: params.runId, userId: params.userId, markdown: "# Draft", status: "pending_approval", ...extra })
    .returning({ id: schema.drafts.id });
  return row!.id;
}

/** Persisted candidates for the run, as discover would have written them. */
export async function seedCandidates(params: PipelineParams, briefs: Array<{ title: string; summary: string; whyItMatters: string; sourceUrls: string[] }>) {
  const refs = [];
  for (const b of briefs) {
    const [row] = await shared.db
      .insert(schema.topicCandidates)
      .values({ runId: params.runId, userId: params.userId, title: b.title, summary: b.summary, sourceUrls: b.sourceUrls })
      .returning({ id: schema.topicCandidates.id });
    refs.push({ id: row!.id, ...b });
  }
  return refs;
}

/** A global web_search route (Tavily) so the search step has somewhere to go. */
export async function seedSearchRoute(): Promise<void> {
  await shared.db.insert(schema.aiRoutes).values({ userId: null, taskType: "web_search", priority: 0, provider: "tavily", model: "tavily-search" });
}
