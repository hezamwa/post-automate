export interface Env {
  // Bindings
  PIPELINE: Workflow;
  DB?: Hyperdrive; // absent in local dev — DATABASE_URL is used instead
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
  BRAVE_API_KEY: string;
  // Per-creator-project Editor tokens (FR-8.4/8.5): SANITY_TOKEN_<PROJECTID>.
  // Publishing resolves dynamically: env[`SANITY_TOKEN_${projectId.toUpperCase()}`].
  SANITY_TOKEN_R9ZDT0S0: string; // waleed_alhezam_personal_website
  SANITY_TOKEN_5GZ3NGJS: string; // Afnan Almass Personal Website
  JWT_SIGNING_KEY: string;
  FCM_SERVICE_ACCOUNT: string;
  SANITY_WEBHOOK_SECRET: string;
  DATABASE_URL?: string;
}
