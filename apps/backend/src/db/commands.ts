// Write-side helpers for pipeline runs and drafts (CQRS command side, AR-10.6).
import { eq } from "drizzle-orm";
import { schema, type Db } from "./client";

type RunState = (typeof schema.runState.enumValues)[number];

export async function createRun(
  db: Db,
  args: {
    userId: string;
    trigger: "cron" | "manual" | "user_topic";
    profileVersion: number;
    userTopic?: { title: string; notes?: string; links?: string[] };
    workflowInstanceId?: string;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.pipelineRuns)
    .values({
      userId: args.userId,
      trigger: args.trigger,
      profileVersion: args.profileVersion,
      userTopic: args.userTopic ?? null,
      workflowInstanceId: args.workflowInstanceId ?? null,
      state: "discovering",
    })
    .returning({ id: schema.pipelineRuns.id });
  return row!;
}

export async function setRunState(db: Db, runId: string, state: RunState, error?: string): Promise<void> {
  const terminal: RunState[] = ["published", "skipped", "rejected", "expired", "failed"];
  await db
    .update(schema.pipelineRuns)
    .set({
      state,
      error: error ?? null,
      ...(terminal.includes(state) ? { finishedAt: new Date() } : {}),
    })
    .where(eq(schema.pipelineRuns.id, runId));
}

export async function createDraft(
  db: Db,
  args: {
    runId: string;
    userId: string;
    topicId: string;
    angle: unknown;
    markdown: string; // editing source-of-truth until publish (DR-9.11)
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.drafts)
    .values({
      runId: args.runId,
      userId: args.userId,
      topicId: args.topicId,
      angle: args.angle,
      markdown: args.markdown,
      status: "pending_approval",
    })
    .returning({ id: schema.drafts.id });
  return row!;
}
