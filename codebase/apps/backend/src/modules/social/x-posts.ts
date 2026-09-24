import { expectOk, type Fetcher } from "./types";

// X posting (FR-18.2, design §17): the post, the link as a reply to it, and deletion.

const TWEETS = "https://api.x.com/2/tweets";

export async function xCreatePost(accessToken: string, text: string, replyTo?: string, f: Fetcher = fetch): Promise<string> {
  const res = await expectOk(
    "x",
    await f(TWEETS, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) }),
    }),
  );
  const { data } = (await res.json()) as { data: { id: string } };
  return data.id;
}

export async function xDeletePost(accessToken: string, id: string, f: Fetcher = fetch): Promise<void> {
  await expectOk("x", await f(`${TWEETS}/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }));
}

export const xPostUrl = (handle: string, id: string) => `https://x.com/${handle.replace(/^@/, "")}/status/${id}`;
