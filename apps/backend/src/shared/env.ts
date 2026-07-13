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
  SANITY_WRITE_TOKEN: string;
  JWT_SIGNING_KEY: string;
  FCM_SERVICE_ACCOUNT: string;
  SANITY_WEBHOOK_SECRET: string;
  DATABASE_URL?: string;
}
