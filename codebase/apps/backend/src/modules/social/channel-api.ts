import type { Env } from "../../shared/env";
import { DEFAULT_LINKEDIN_VERSION, linkedinComment, linkedinCreatePost, linkedinDeletePost, linkedinPostUrl } from "./linkedin-posts";
import type { LiveConnection } from "./tokens";
import type { Fetcher, SocialProvider } from "./types";
import { xCreatePost, xDeletePost, xPostUrl } from "./x-posts";

// One shape over both platforms (design §17 step 3): post the text, add the link under
// it (X reply / LinkedIn first comment), delete a post.

export interface ChannelApi {
  post(conn: LiveConnection, text: string): Promise<{ postId: string; postUrl: string }>;
  addLink(conn: LiveConnection, postId: string, url: string): Promise<string>;
  /** X: the link reply is its own tweet and is deleted too; a LinkedIn comment goes with its post. */
  remove(conn: LiveConnection, postId: string, replyId: string | null): Promise<void>;
}

export function channelApi(env: Env, channel: SocialProvider, f: Fetcher = fetch): ChannelApi {
  if (channel === "x") {
    return {
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
    post: async (conn, text) => {
      const postId = await linkedinCreatePost(conn.accessToken, { memberId: conn.accountId, text, version }, f);
      return { postId, postUrl: linkedinPostUrl(postId) };
    },
    addLink: (conn, postId, url) => linkedinComment(conn.accessToken, { memberId: conn.accountId, postUrn: postId, text: url, version }, f),
    remove: (conn, postId) => linkedinDeletePost(conn.accessToken, { postUrn: postId, version }, f),
  };
}
