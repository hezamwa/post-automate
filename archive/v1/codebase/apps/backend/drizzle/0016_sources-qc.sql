CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_run_url" UNIQUE("run_id","url")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "quality_check" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "outline" jsonb;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- New task types (article-workflow §3 steps 6, 8, 10) need routes from the same deploy, or
-- every run fails at `outline` with NoRouteError. Same defaults as registry.ts (Haiku
-- primary, gpt-5-mini fallback); an admin can change them from the dashboard afterwards.
-- Only on a database that is already routed (has the global article route): a fresh
-- environment gets its routes from tools/seed.ts, and the test harness must stay empty.
-- ON CONFLICT covers a database where an admin added these already.
INSERT INTO "ai_routes" ("user_id", "task_type", "priority", "provider", "model", "params", "enabled", "version")
SELECT NULL, v.task_type, v.priority, v.provider, v.model, '{}'::jsonb, true, 1
FROM (VALUES
  ('outline',        0, 'anthropic', 'claude-haiku-4-5'),
  ('outline',        1, 'openai',    'gpt-5-mini'),
  ('quality_check',  0, 'anthropic', 'claude-haiku-4-5'),
  ('quality_check',  1, 'openai',    'gpt-5-mini'),
  ('image_concepts', 0, 'anthropic', 'claude-haiku-4-5'),
  ('image_concepts', 1, 'openai',    'gpt-5-mini')
) AS v(task_type, priority, provider, model)
WHERE EXISTS (SELECT 1 FROM "ai_routes" WHERE "user_id" IS NULL AND "task_type" = 'article')
ON CONFLICT ("user_id", "task_type", "priority") DO NOTHING;
