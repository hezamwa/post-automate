import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../../db/client";
import type { SocialProvider } from "./types";

// social_posts rows (DR-9.18): one per draft and channel.

export type PostRow = typeof schema.socialPosts.$inferSelect;
type PostPatch = Partial<Pick<PostRow, "status" | "postId" | "replyId" | "postUrl" | "reason" | "postedAt">>;

export async function postRow(db: Db, draftId: string, channel: SocialProvider): Promise<PostRow | null> {
  const [row] = await db
    .select()
    .from(schema.socialPosts)
    .where(and(eq(schema.socialPosts.draftId, draftId), eq(schema.socialPosts.channel, channel)));
  return row ?? null;
}

/** Create the row, or update its status and reason — the platform ids are never cleared here. */
export async function upsertPostRow(
  db: Db,
  args: { draftId: string; userId: string; channel: SocialProvider; status: PostRow["status"]; reason?: string | null },
): Promise<PostRow> {
  const set = { status: args.status, reason: args.reason ?? null, updatedAt: new Date() };
  const [row] = await db
    .insert(schema.socialPosts)
    .values({ draftId: args.draftId, userId: args.userId, channel: args.channel, ...set })
    .onConflictDoUpdate({ target: [schema.socialPosts.draftId, schema.socialPosts.channel], set })
    .returning();
  return row!;
}

export async function patchPostRow(db: Db, id: string, patch: PostPatch): Promise<PostRow> {
  const [row] = await db
    .update(schema.socialPosts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.socialPosts.id, id))
    .returning();
  return row!;
}

export async function postsForDraft(db: Db, draftId: string): Promise<PostRow[]> {
  return db.select().from(schema.socialPosts).where(eq(schema.socialPosts.draftId, draftId));
}

/** The app's view (FR-18.5): status, link, reason — no platform ids. */
export const postView = (r: PostRow) => ({ channel: r.channel, status: r.status, postUrl: r.postUrl, reason: r.reason, postedAt: r.postedAt });
