CREATE TYPE "public"."candidate_source" AS ENUM('discovered', 'user');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending_approval', 'revising', 'scheduled', 'rejected', 'expired', 'published', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('ok', 'auth_error', 'quota', 'rate_limited', 'model_not_found', 'timeout', 'provider_error');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('active', 'confirmed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('draft', 'active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."publish_mode" AS ENUM('now', 'next_slot');--> statement-breakpoint
CREATE TYPE "public"."rejection_category" AS ENUM('quality', 'changed_mind', 'other');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('discovering', 'scoring', 'drafting', 'pending_approval', 'publishing', 'published', 'skipped', 'rejected', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('cron', 'manual', 'user_topic');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "ai_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"status" "health_status" NOT NULL,
	"latency_ms" integer,
	"message" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"task_type" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_id" uuid,
	"angle" jsonb,
	"markdown" text,
	"sanity_document_id" text,
	"status" "draft_status" DEFAULT 'pending_approval' NOT NULL,
	"rejection_category" "rejection_category",
	"publish_mode" "publish_mode",
	"publish_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"diff" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "onboarding_status" DEFAULT 'active' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partial_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_instance_id" text,
	"profile_version" integer NOT NULL,
	"trigger" "run_trigger" DEFAULT 'cron' NOT NULL,
	"user_topic" jsonb,
	"state" "run_state" DEFAULT 'discovering' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "profile_status" DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"run_id" uuid,
	"task_type" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"units" jsonb NOT NULL,
	"est_cost_usd" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "candidate_source" DEFAULT 'discovered' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" numeric,
	"rejection_reason" text,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_limits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"monthly_cap_usd" numeric DEFAULT '10' NOT NULL,
	"max_runs_per_day" integer DEFAULT 2 NOT NULL,
	"max_req_per_min" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"fcm_token" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"sanity_project_id" text,
	"sanity_dataset" text DEFAULT 'production' NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_health_checks" ADD CONSTRAINT "ai_health_checks_route_id_ai_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."ai_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_routes" ADD CONSTRAINT "ai_routes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_topic_id_topic_candidates_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_diffs" ADD CONSTRAINT "edit_diffs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_diffs" ADD CONSTRAINT "edit_diffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_candidates" ADD CONSTRAINT "topic_candidates_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_candidates" ADD CONSTRAINT "topic_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_routes_user_task_priority" ON "ai_routes" USING btree ("user_id","task_type","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_version" ON "profiles" USING btree ("user_id","version");