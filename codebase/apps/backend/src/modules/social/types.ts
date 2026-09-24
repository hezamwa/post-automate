import type { Env } from "../../shared/env";

// The social-provider contract (design §17): each platform is one file implementing it,
// with raw fetch (Workers-native, no SDK). Posting joins it in the posting phase.

export type SocialProvider = "x" | "linkedin";
export type Fetcher = typeof fetch;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** seconds */
  expiresIn: number;
  refreshExpiresIn?: number;
  scope: string;
}

export interface SocialAccount {
  id: string;
  handle: string;
}

export interface OAuthProvider {
  name: SocialProvider;
  /** Client credentials are set — otherwise connecting answers 503 with this reason. */
  missingConfig(env: Env): string | null;
  /** PKCE is used when the provider supports it (X); LinkedIn's standard flow does not. */
  usesPkce: boolean;
  authorizeUrl(env: Env, args: { state: string; redirectUri: string; codeChallenge?: string }): string;
  exchangeCode(env: Env, args: { code: string; redirectUri: string; codeVerifier?: string }, f?: Fetcher): Promise<TokenSet>;
  refresh(env: Env, refreshToken: string, f?: Fetcher): Promise<TokenSet>;
  account(accessToken: string, f?: Fetcher): Promise<SocialAccount>;
  /** Best-effort revoke at the platform; absent where the platform has none for members. */
  revoke?(env: Env, token: string, f?: Fetcher): Promise<void>;
}

/** A platform refusal, with the platform's own words — shown to the user as the reason. */
export class SocialApiError extends Error {
  constructor(
    readonly provider: SocialProvider,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider === "x" ? "X" : "LinkedIn"} refused (HTTP ${status}): ${detail.slice(0, 300)}`);
  }
}

export async function expectOk(provider: SocialProvider, res: Response): Promise<Response> {
  if (res.ok) return res;
  throw new SocialApiError(provider, res.status, await res.text().catch(() => ""));
}
