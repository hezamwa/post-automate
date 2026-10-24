CREATE TYPE "public"."social_post_status" AS ENUM('awaiting_confirm', 'posted', 'failed', 'not_connected', 'deleted');--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "social_provider" NOT NULL,
	"status" "social_post_status" NOT NULL,
	"post_id" text,
	"reply_id" text,
	"post_url" text,
	"reason" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_posts_draft_channel" UNIQUE("draft_id","channel")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "site_url" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;