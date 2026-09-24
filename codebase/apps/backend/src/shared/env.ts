export interface Env {
  // Bindings
  PIPELINE: Workflow;
  DB?: Hyperdrive; // absent in local dev — DATABASE_URL is used instead
  BACKUPS?: R2Bucket; // weekly Sanity export destination (NFR-16.3); absent until R2 is enabled
  ENVIRONMENT: "development" | "staging" | "production";

  // Secrets (wrangler secret put / .dev.vars) — platform-owned, FR-15.9
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GOOGLE_AI_API_KEY: string;
  MOONSHOT_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  QWEN_API_KEY: string;
  GROK_API_KEY: string;
  MANUS_API_KEY: string;
  TAVILY_API_KEY: string;
  // Per-creator-project Editor tokens (FR-8.4/8.5): SANITY_TOKEN_<PROJECTID>.
  // Publishing resolves dynamically: env[`SANITY_TOKEN_${projectId.toUpperCase()}`].
  SANITY_TOKEN_R9ZDT0S0: string; // waleed_alhezam_personal_website
  SANITY_TOKEN_5GZ3NGJS: string; // Afnan Almass Personal Website
  JWT_SIGNING_KEY: string;
  FCM_SERVICE_ACCOUNT: string;
  SANITY_WEBHOOK_SECRET: string;
  // Social publishing (requirements §18, design §17). Optional: unset = connecting is
  // refused with a readable 503, nothing else is affected.
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  SOCIAL_TOKEN_KEY?: string; // base64, 32 bytes — AES-GCM key for stored tokens (NFR-11.8)
  LINKEDIN_API_VERSION?: string; // YYYYMM; the default lives in modules/social/linkedin.ts
  DATABASE_URL?: string;
  // Optional: Cloudflare AI Gateway route for Anthropic (design §6.4). Unset = direct API.
  AI_GATEWAY_ANTHROPIC_BASE_URL?: string;
}
