import { expectOk, SocialApiError, type Fetcher } from "./types";

// LinkedIn posting (FR-18.2, design §17): the post on the member's feed, the link as its
// first comment, and deletion — the versioned REST API.

/** YYYYMM. LinkedIn retires a version after about a year — override with LINKEDIN_API_VERSION. */
export const DEFAULT_LINKEDIN_VERSION = "202607";
const REST = "https://api.linkedin.com/rest";

const headers = (accessToken: string, version: string) => ({
  authorization: `Bearer ${accessToken}`,
  "LinkedIn-Version": version,
  "X-Restli-Protocol-Version": "2.0.0",
  "content-type": "application/json",
});

// "Little text" (the commentary format): these characters must be backslash-escaped, and a
// hashtag is a template — otherwise text after a stray "(" or "@" silently disappears.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string) => s.replace(RESERVED, (ch) => `\\${ch}`);

export function toLittleText(text: string): string {
  return text
    .split(/(#[\p{L}\p{N}_]+)/u)
    .map((part) => (/^#[\p{L}\p{N}_]+$/u.test(part) ? `{hashtag|\\#|${escapeLittle(part.slice(1))}}` : escapeLittle(part)))
    .join("");
}

export async function linkedinCreatePost(accessToken: string, args: { memberId: string; text: string; version: string }, f: Fetcher = fetch): Promise<string> {
  const res = await expectOk(
    "linkedin",
    await f(`${REST}/posts`, {
      method: "POST",
      headers: headers(accessToken, args.version),
      body: JSON.stringify({
        author: `urn:li:person:${args.memberId}`,
        commentary: toLittleText(args.text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    }),
  );
  const urn = res.headers.get("x-restli-id");
  if (!urn) throw new SocialApiError("linkedin", res.status, "the post was accepted but no post id came back");
  return urn;
}

export async function linkedinComment(
  accessToken: string,
  args: { memberId: string; postUrn: string; text: string; version: string },
  f: Fetcher = fetch,
): Promise<string> {
  const res = await expectOk(
    "linkedin",
    await f(`${REST}/socialActions/${encodeURIComponent(args.postUrn)}/comments`, {
      method: "POST",
      headers: headers(accessToken, args.version),
      body: JSON.stringify({ actor: `urn:li:person:${args.memberId}`, object: args.postUrn, message: { text: args.text } }),
    }),
  );
  return res.headers.get("x-restli-id") ?? ((await res.json().catch(() => ({}))) as { id?: string }).id ?? "comment";
}

export async function linkedinDeletePost(accessToken: string, args: { postUrn: string; version: string }, f: Fetcher = fetch): Promise<void> {
  await expectOk("linkedin", await f(`${REST}/posts/${encodeURIComponent(args.postUrn)}`, { method: "DELETE", headers: headers(accessToken, args.version) }));
}

export const linkedinPostUrl = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;
