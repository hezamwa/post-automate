ALTER TYPE "public"."run_state" ADD VALUE 'abandoned';--> statement-breakpoint
CREATE TABLE "gate_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"options_shown" jsonb NOT NULL,
	"choice" jsonb NOT NULL,
	"free_text" text,
	"source" text DEFAULT 'user' NOT NULL,
	"chosen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "gate" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "chosen_topic_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "chosen_angle_index" integer;--> statement-breakpoint
ALTER TABLE "topic_candidates" ADD COLUMN "why_it_matters" text;--> statement-breakpoint
ALTER TABLE "gate_choices" ADD CONSTRAINT "gate_choices_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_choices" ADD CONSTRAINT "gate_choices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_chosen_topic_id_topic_candidates_id_fk" FOREIGN KEY ("chosen_topic_id") REFERENCES "public"."topic_candidates"("id") ON DELETE no action ON UPDATE no action;