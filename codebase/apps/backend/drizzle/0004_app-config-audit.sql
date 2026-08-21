CREATE TYPE "public"."config_source" AS ENUM('admin', 'seed', 'migration');--> statement-breakpoint
CREATE TABLE "app_config_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"changed_by" uuid,
	"source" "config_source" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_audit_actor" CHECK (("app_config_audit"."source" = 'admin') = ("app_config_audit"."changed_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "app_config_audit" ADD CONSTRAINT "app_config_audit_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;