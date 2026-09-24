import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { GateError } from "../../ai/gates";
import { schema, type Db } from "../../db/client";
import type { Env } from "../../shared/env";
import { getFlags } from "../../shared/flags";
import { notifyUser } from "../../shared/notify";
import { latestDerivativeRevision } from "../generation";
import { getActiveProfile } from "../profiles";
import { getDocument } from "../publishing/sanity";
import { articleUrl, linkFieldsOf } from "../publishing/url";
import { connectionState, getConnection } from "./accounts";
import { channelApi } from "./channel-api";
import { patchPostRow, postRow, upsertPostRow, type PostRow } from "./records";
import { liveConnection } from "./tokens";
import type { Fetcher, SocialProvider } from "./types";

// Posting after publish (FR-18.2–18.5, design §17). The article is already live when any
// of this runs; nothing here may affect it. Every attempt re-checks the guards.

const NAMES = { x: "X", linkedin: "LinkedIn" } as const;
const NOT_CONNECTED = (c: SocialProvider) => `${NAMES[c]} is not connected (or the connection expired) — connect it on your profile page, then tap Retry.`;

/** The produced channel texts at the draft's current revision — what the reviewer approved. */
async function producedTexts(db: Db, draftId: string): Promise<Map<SocialProvider, string>> {
  const revisionNo = await latestDerivativeRevision(db, draftId);
  const rows = await db
    .select()
    .from(schema.draftDerivatives)
    .where(and(eq(schema.draftDerivatives.draftId, draftId), eq(schema.draftDerivatives.revisionNo, revisionNo), inArray(schema.draftDerivatives.kind, ["x", "linkedin"])));
  return new Map(rows.filter((r) => r.outcome === "produced" && r.content).map((r) => [r.kind as SocialProvider, r.content!]));
}

/** Post one channel, or finish a half-done one (only what is missing). Returns the row. */
export async function postChannel(env: Env, db: Db, args: { draftId: string; channel: SocialProvider }, f: Fetcher = fetch): Promise<PostRow> {
  const { draftId, channel } = args;
  if ((await getFlags(db))["publishing.paused"]) {
    throw new GateError("publishing_paused", "Publishing is paused by an administrator — social posts wait with the articles (FR-18.4).");
  }
  const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, draftId) });
  if (!draft || draft.status !== "published" || !draft.sanityDocumentId) throw new Error("only a published article can be posted (FR-18.2)");
  const text = (await producedTexts(db, draftId)).get(channel);
  if (!text) throw new Error(`no approved ${NAMES[channel]} text for this article`);
  const existing = await postRow(db, draftId, channel);
  if (existing?.status === "posted") return existing;
  const fail = (reason: string, status: PostRow["status"] = "failed") => upsertPostRow(db, { draftId, userId: draft.userId, channel, status, reason });

  if (env.ENVIRONMENT !== "production") return fail(`Posting happens only in production (FR-8.5) — this is ${env.ENVIRONMENT}.`);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, draft.userId) });
  if (!user?.siteUrl || !user.sanityProjectId) return fail("The site URL is not set for this account yet — ask an administrator (FR-18.8).");
  const conn = await liveConnection(env, db, draft.userId, channel, f).catch(() => null);
  if (!conn) return fail(NOT_CONNECTED(channel), "not_connected");

  let row = existing ?? (await upsertPostRow(db, { draftId, userId: draft.userId, channel, status: "awaiting_confirm" }));
  try {
    const target = { projectId: user.sanityProjectId, dataset: user.sanityDataset };
    const link = linkFieldsOf(await getDocument(env, target, draft.sanityDocumentId));
    if (!link) throw new Error("the published article has no slug or language to link to");
    const url = articleUrl(user.sanityProjectId, user.siteUrl, { ...link, blogType: draft.blogType ?? link.blogType });
    const api = channelApi(env, channel, f);
    if (!row.postId) row = await patchPostRow(db, row.id, await api.post(conn, text, url)); // written at once: a retry never re-posts
    if (!row.replyId && !api.linkInPost) row = await patchPostRow(db, row.id, { replyId: await api.addLink(conn, row.postId!, url) });
    return await patchPostRow(db, row.id, { status: "posted", reason: null, postedAt: new Date() });
  } catch (e) {
    return patchPostRow(db, row.id, { status: "failed", reason: e instanceof Error ? e.message.slice(0, 500) : "posting failed" });
  }
}

/**
 * Called at the end of publishApprovedDraft, once the article is live (design §17): a row
 * per approved channel — not connected, awaiting confirmation, or posted now (auto mode).
 */
export async function queueSocialPosts(env: Env, db: Db, draftId: string, f: Fetcher = fetch): Promise<void> {
  const draft = await db.query.drafts.findFirst({ where: eq(schema.drafts.id, draftId) });
  if (!draft) return;
  const mode = await getActiveProfile(db, draft.userId).then((p) => p.profile.socialPosting, () => "confirm" as const);
  for (const channel of (await producedTexts(db, draftId)).keys()) {
    const conn = await getConnection(db, draft.userId, channel);
    if (!conn || connectionState(conn) === "expired") {
      await upsertPostRow(db, { draftId, userId: draft.userId, channel, status: "not_connected", reason: NOT_CONNECTED(channel) });
    } else if (mode === "confirm") {
      await upsertPostRow(db, { draftId, userId: draft.userId, channel, status: "awaiting_confirm" });
    } else {
      const row = await postChannel(env, db, { draftId, channel }, f);
      if (row.status === "failed") {
        await notifyUser(env, db, draft.userId, { title: `Posting to ${NAMES[channel]} failed`, body: `${row.reason ?? ""} Open the article to retry.`, data: { draftId } });
      }
    }
  }
}

/** FR-18.6: retract takes the channel posts down too. Returns what could not be deleted. */
export async function deleteSocialPosts(env: Env, db: Db, draftId: string, f: Fetcher = fetch): Promise<Array<{ channel: SocialProvider; reason: string }>> {
  const failures: Array<{ channel: SocialProvider; reason: string }> = [];
  // anything that reached the platform — a post whose link step failed included
  const rows = await db
    .select()
    .from(schema.socialPosts)
    .where(and(eq(schema.socialPosts.draftId, draftId), isNotNull(schema.socialPosts.postId), ne(schema.socialPosts.status, "deleted")));
  for (const row of rows) {
    try {
      const conn = await liveConnection(env, db, row.userId, row.channel, f);
      if (!conn) throw new Error(`${NAMES[row.channel]} is not connected — delete the post on ${NAMES[row.channel]} yourself`);
      await channelApi(env, row.channel, f).remove(conn, row.postId!, row.replyId);
      await patchPostRow(db, row.id, { status: "deleted", reason: null });
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 500) : "delete failed";
      await patchPostRow(db, row.id, { reason });
      failures.push({ channel: row.channel, reason });
    }
  }
  return failures;
}
