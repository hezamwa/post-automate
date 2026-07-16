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

export async function getUserById(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new Error(`user ${userId} not found`);
  return user;
}

export async function updateDraftMarkdown(db: Db, draftId: string, markdown: string): Promise<void> {
  await db.update(schema.drafts).set({ markdown }).where(eq(schema.drafts.id, draftId));
}

export async function setDraftStatus(
  db: Db,
  draftId: string,
  status: (typeof schema.draftStatus.enumValues)[number],
): Promise<void> {
  await db.update(schema.drafts).set({ status }).where(eq(schema.drafts.id, draftId));
}

/** Approve-for-next-slot (FR-7.5): the hourly publisher executes at publish_at. */
export async function scheduleDraft(db: Db, draftId: string, publishAt: Date): Promise<void> {
  await db
    .update(schema.drafts)
    .set({ status: "scheduled", publishMode: "next_slot", publishAt, decidedAt: new Date() })
    .where(eq(schema.drafts.id, draftId));
}

/** Reject with category (FR-7.8); markdown purged (DR-9.11). */
export async function rejectDraft(
  db: Db,
  draftId: string,
  category: "quality" | "changed_mind" | "other",
): Promise<void> {
  await db
    .update(schema.drafts)
    .set({ status: "rejected", rejectionCategory: category, markdown: null, decidedAt: new Date() })
    .where(eq(schema.drafts.id, draftId));
}

export async function expireDraft(db: Db, draftId: string): Promise<void> {
  await db
    .update(schema.drafts)
    .set({ status: "expired", markdown: null, decidedAt: new Date() })
    .where(eq(schema.drafts.id, draftId));
}

/** Revision instructions feed profile refinement (FR-7.9, DR-9.12). */
export async function addDraftRevision(
  db: Db,
  args: { draftId: string; revisionNo: number; instructions: string },
): Promise<void> {
  await db.insert(schema.draftRevisions).values(args);
}

/** FR-6.9: manual-edit capture. Stored as before/after JSON for now (TODO: unified diff). */
export async function addEditDiff(
  db: Db,
  args: { draftId: string; userId: string; before: string; after: string },
): Promise<void> {
  await db.insert(schema.editDiffs).values({
    draftId: args.draftId,
    userId: args.userId,
    diff: JSON.stringify({ before: args.before, after: args.after }),
  });
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
