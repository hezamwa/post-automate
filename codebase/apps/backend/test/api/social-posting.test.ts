import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShared, shared } from "../workflow/preamble";
import { techProfile } from "../fixtures";
import { schema } from "../../src/db/client";
import { recordDerivatives } from "../../src/db/commands";
import { publishApprovedDraft } from "../../src/modules/publishing";
import { createProfileVersion } from "../../src/modules/profiles";
import { saveConnection } from "../../src/modules/social/accounts";
import { queueSocialPosts } from "../../src/modules/social/post";
import type { Env } from "../../src/shared/env";
import { seedDraftRow, startRun } from "../workflow/harness";
import { apiEnv, call, tokenFor } from "./client";

// Posting after publish (FR-18.2–18.6, design §17): text only, then the article link as
// an X reply / LinkedIn first comment; confirm vs auto; retries post only what is missing;
// guards; retract deletes. The platforms are a fake fetch; Sanity is the shared fake.
beforeEach(resetShared);
afterEach(() => vi.unstubAllGlobals());

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const env = () => Object.assign(apiEnv().env, { SOCIAL_TOKEN_KEY: KEY }) as Env;

/** Fake X + LinkedIn. `failReplies` makes the link step fail until cleared. */
function platforms(opts: { failReplies?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  let n = 0;
  const state = { failReplies: opts.failReplies ?? false };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method: init.method ?? "GET", url, body });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const isReply = "reply" in body || url.includes("/comments");
    if (isReply && state.failReplies) return new Response("over capacity", { status: 503 });
    if (url.startsWith("https://api.x.com/2/tweets")) return Response.json({ data: { id: `t${++n}` } }, { status: 201 });
    return new Response(null, { status: 201, headers: { "x-restli-id": url.includes("/comments") ? `c${++n}` : `urn:li:share:${++n}` } });
  });
  return { calls, state };
}

async function publishedDraft(opts: { mode?: "confirm" | "auto"; connect?: Array<"x" | "linkedin">; siteUrl?: string | null } = {}) {
  const params = await startRun();
  const { userId } = params;
  await shared.db.update(schema.users).set({ siteUrl: opts.siteUrl === undefined ? "https://waleedalhezam.sa" : opts.siteUrl }).where(eq(schema.users.id, userId));
  if (opts.mode) await createProfileVersion(shared.db, userId, techProfile({ socialPosting: opts.mode }));
  const docId = `postauto-${params.runId}`;
  shared.sanity.docs.set(docId, { _id: docId, slug: { current: "ai-tools" }, language: "en" });
  const draftId = await seedDraftRow(params, { status: "published", sanityDocumentId: docId, markdown: null });
  await recordDerivatives(shared.db, draftId, 0, [
    { kind: "x", outcome: "produced", content: "Short X text #AI" },
    { kind: "linkedin", outcome: "produced", content: "LinkedIn (long) text" },
  ]);
  for (const provider of opts.connect ?? ["x", "linkedin"]) {
    await saveConnection(env(), shared.db, { userId, provider, account: { id: `${provider}-id`, handle: provider === "x" ? "@waleed" : "Waleed" }, tokens: { accessToken: "AT", expiresIn: 86400 * 30, scope: "" } });
  }
  return { userId, draftId, token: await tokenFor(userId) };
}

const rowsOf = (draftId: string) => shared.db.select().from(schema.socialPosts).where(eq(schema.socialPosts.draftId, draftId));

describe("auto mode, from publishApprovedDraft", () => {
  it("posts the text only, then the link as a reply / first comment", async () => {
    const { calls } = platforms();
    const params = await startRun();
    await shared.db.update(schema.users).set({ siteUrl: "https://waleedalhezam.sa" }).where(eq(schema.users.id, params.userId));
    await createProfileVersion(shared.db, params.userId, techProfile({ socialPosting: "auto" }));
    const draftDoc = `drafts.postauto-${params.runId}`;
    shared.sanity.docs.set(draftDoc, { _id: draftDoc, slug: { current: "ai-tools" }, language: "en" });
    const draftId = await seedDraftRow(params, { sanityDocumentId: draftDoc });
    await recordDerivatives(shared.db, draftId, 0, [{ kind: "x", outcome: "produced", content: "Short X text #AI" }]);
    await saveConnection(env(), shared.db, { userId: params.userId, provider: "x", account: { id: "1", handle: "@waleed" }, tokens: { accessToken: "AT", expiresIn: 86400, scope: "" } });

    const user = (await shared.db.query.users.findFirst({ where: eq(schema.users.id, params.userId) }))!;
    await publishApprovedDraft(env(), shared.db, { user, draftId });

    expect(calls.map((c) => c.body)).toEqual([
      { text: "Short X text #AI" },
      { text: "https://waleedalhezam.sa/en/blog/ai-tools", reply: { in_reply_to_tweet_id: "t1" } },
    ]);
    expect(await rowsOf(draftId)).toMatchObject([{ channel: "x", status: "posted", postId: "t1", replyId: "t2", postUrl: "https://x.com/waleed/status/t1" }]);
  });

  it("LinkedIn: one post — escaped text, the article link on its last line, no comment", async () => {
    const { calls } = platforms();
    const { draftId } = await publishedDraft({ mode: "auto", connect: ["linkedin"] });
    await queueSocialPosts(env(), shared.db, draftId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.linkedin.com/rest/posts",
      body: { author: "urn:li:person:linkedin-id", commentary: "LinkedIn \\(long\\) text\n\nhttps://waleedalhezam.sa/en/blog/ai-tools" },
    });
    const rows = await rowsOf(draftId);
    expect(rows.find((r) => r.channel === "linkedin")).toMatchObject({ status: "posted", postUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/" });
    expect(rows.find((r) => r.channel === "x")).toMatchObject({ status: "not_connected" });
  });
});

describe("confirm mode and the post/retry route", () => {
  it("records awaiting_confirm; POST /drafts/:id/social/:channel posts it", async () => {
    const { calls } = platforms();
    const { draftId, token } = await publishedDraft({ connect: ["x"] });
    await queueSocialPosts(env(), shared.db, draftId);
    expect(calls).toHaveLength(0);
    expect((await rowsOf(draftId)).find((r) => r.channel === "x")?.status).toBe("awaiting_confirm");

    const res = await call(env(), `/drafts/${draftId}/social/x`, { method: "POST", token });
    expect(res.json.post).toMatchObject({ channel: "x", status: "posted", postUrl: "https://x.com/waleed/status/t1" });
    expect((await call(env(), `/drafts/${draftId}`, { token })).json.socialPosts).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: "x", status: "posted" })]),
    );
  });

  it("a failed link step keeps the post; the retry posts only the reply", async () => {
    const { calls, state } = platforms({ failReplies: true });
    const { draftId, token } = await publishedDraft({ connect: ["x"] });
    const first = await call(env(), `/drafts/${draftId}/social/x`, { method: "POST", token });
    expect(first.json.post).toMatchObject({ status: "failed", reason: expect.stringContaining("HTTP 503") });
    state.failReplies = false;
    calls.length = 0;
    const retry = await call(env(), `/drafts/${draftId}/social/x`, { method: "POST", token });
    expect(retry.json.post).toMatchObject({ status: "posted" });
    expect(calls.map((c) => c.body)).toEqual([{ text: "https://waleedalhezam.sa/en/blog/ai-tools", reply: { in_reply_to_tweet_id: "t1" } }]);
  });
});

describe("guards", () => {
  it("no site URL, not production, not connected → recorded with the reason, nothing posted", async () => {
    const { calls } = platforms();
    const noSite = await publishedDraft({ siteUrl: null });
    expect((await call(env(), `/drafts/${noSite.draftId}/social/x`, { method: "POST", token: noSite.token })).json.post).toMatchObject({ status: "failed", reason: expect.stringContaining("site URL") });
    const staging = Object.assign(env(), { ENVIRONMENT: "staging" });
    expect((await call(staging, `/drafts/${noSite.draftId}/social/x`, { method: "POST", token: noSite.token })).json.post).toMatchObject({ reason: expect.stringContaining("only in production") });
    const unconnected = await publishedDraft({ connect: [] });
    expect((await call(env(), `/drafts/${unconnected.draftId}/social/linkedin`, { method: "POST", token: unconnected.token })).json.post).toMatchObject({ status: "not_connected" });
    expect(calls).toHaveLength(0);
  });

  it("publishing.paused holds posting (503); an unpublished draft is 409", async () => {
    platforms();
    const { draftId, token } = await publishedDraft();
    await shared.db.insert(schema.appConfig).values({ key: "publishing.paused", value: true });
    expect((await call(env(), `/drafts/${draftId}/social/x`, { method: "POST", token })).status).toBe(503);
    await shared.db.update(schema.drafts).set({ status: "scheduled" }).where(eq(schema.drafts.id, draftId));
    expect((await call(env(), `/drafts/${draftId}/social/x`, { method: "POST", token })).status).toBe(409);
  });
});

describe("retract (FR-18.6)", () => {
  it("deletes the X post and its reply, and the LinkedIn post", async () => {
    const { calls } = platforms();
    const { draftId, token } = await publishedDraft({ mode: "auto" });
    await queueSocialPosts(env(), shared.db, draftId);
    calls.length = 0;
    const res = await call(env(), `/drafts/${draftId}/retract`, { method: "POST", token });
    expect(res.json).toMatchObject({ ok: true, socialNotDeleted: [] });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url).sort()).toEqual(
      ["https://api.x.com/2/tweets/t1", "https://api.x.com/2/tweets/t2", `https://api.linkedin.com/rest/posts/${encodeURIComponent("urn:li:share:3")}`].sort(),
    );
    expect((await rowsOf(draftId)).map((r) => r.status)).toEqual(["deleted", "deleted"]);
  });
});
