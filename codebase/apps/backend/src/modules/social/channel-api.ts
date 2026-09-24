import type { Env } from "../../shared/env";
import { DEFAULT_LINKEDIN_VERSION, LINKEDIN_MAX_POST_CHARS, linkedinCreatePost, linkedinDeletePost, linkedinPostUrl } from "./linkedin-posts";
import type { LiveConnection } from "./tokens";
import type { Fetcher, SocialProvider } from "./types";
import { xCreatePost, xDeletePost, xPostUrl } from "./x-posts";

// One shape over both platforms (design §17 step 3): X posts the text and adds the link as
// a reply; LinkedIn carries the link on the post's last line (OD-27 revised 2026-09-24 —
// commenting needs LinkedIn's partner-only Community Management API).

export interface ChannelApi {
  /** true: the link is part of the post itself, so there is no second call. */
  linkInPost: boolean;
  post(conn: LiveConnection, text: string, url: string): Promise<{ postId: string; postUrl: string }>;
  addLink(conn: LiveConnection, postId: string, url: string): Promise<string>;
  /** X: the link reply is its own tweet and is deleted too; a LinkedIn comment goes with its post. */
  remove(conn: LiveConnection, postId: string, replyId: string | null): Promise<void>;
}

export function channelApi(env: Env, channel: SocialProvider, f: Fetcher = fetch): ChannelApi {
  if (channel === "x") {
    return {
      linkInPost: false,
      post: async (conn, text) => {
        const postId = await xCreatePost(conn.accessToken, text, undefined, f);
        return { postId, postUrl: xPostUrl(conn.handle, postId) };
      },
      addLink: (conn, postId, url) => xCreatePost(conn.accessToken, url, postId, f),
      remove: async (conn, postId, replyId) => {
        if (replyId) await xDeletePost(conn.accessToken, replyId, f);
        await xDeletePost(conn.accessToken, postId, f);
      },
    };
  }
  const version = env.LINKEDIN_API_VERSION || DEFAULT_LINKEDIN_VERSION;
  return {
    linkInPost: true,
    post: async (conn, text, url) => {
      const postId = await linkedinCreatePost(conn.accessToken, { memberId: conn.accountId, text: withLink(text, url), version }, f);
      return { postId, postUrl: linkedinPostUrl(postId) };
    },
    addLink: async () => {
      throw new Error("LinkedIn carries the link in the post itself");
    },
    remove: (conn, postId) => linkedinDeletePost(conn.accessToken, { postUrn: postId, version }, f),
  };
}

/** The approved text, then the article URL on its own last line — trimmed so both fit. */
export function withLink(text: string, url: string): string {
  const room = LINKEDIN_MAX_POST_CHARS - url.length - 2;
  const body = text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text;
  return `${body}\n\n${url}`;
}
