CREATE TYPE "public"."model_capability" AS ENUM('chat', 'image', 'tts', 'video', 'search');--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" "model_capability" NOT NULL,
	"input_per_mtok_usd" numeric,
	"output_per_mtok_usd" numeric,
	"per_image_usd" numeric,
	"per_search_usd" numeric,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_provider_model" UNIQUE("provider","model")
);
--> statement-breakpoint
-- Seed the registry with the models that lived in code until now (FR-15.4). This is not
-- optional: routing validates against this table from the same deploy, so an empty
-- ai_models would invalidate every existing route in ai_routes at once. Values are copied
-- verbatim from the old MODEL_REGISTRY constant — including grok-4's absent prices, which
-- are why it was never routable (meter.ts refuses unpriced usage) and stays that way until
-- someone fills them in from the dashboard.
INSERT INTO "ai_models" ("provider", "model", "capability", "input_per_mtok_usd", "output_per_mtok_usd", "per_image_usd", "per_search_usd", "notes") VALUES
  ('anthropic', 'claude-sonnet-5',   'chat',   3,    15,   NULL, 0.01,  NULL),
  ('anthropic', 'claude-haiku-4-5',  'chat',   1,    5,    NULL, 0.01,  NULL),
  ('openai',    'gpt-image-1',       'image',  NULL, NULL, 0.04, NULL,  NULL),
  ('openai',    'gpt-4.1-mini',      'chat',   0.4,  1.6,  NULL, 0.01,  'Verified live 2026-07-16 via /v1/models; prices are estimates'),
  ('openai',    'gpt-5-mini',        'chat',   0.25, 2,    NULL, 0.01,  'Verified live 2026-07-16 via /v1/models; prices are estimates'),
  ('grok',      'grok-4',            'chat',   NULL, NULL, NULL, NULL,  'Unpriced — confirm xAI pricing before routing to it'),
  ('brave',     'brave-web-search',  'search', NULL, NULL, NULL, 0.005, 'Search-only; no chat adapter, so no task can route to it yet')
ON CONFLICT ("provider", "model") DO NOTHING;
