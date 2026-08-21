CREATE TYPE "public"."derivative_kind" AS ENUM('hero_image', 'x', 'linkedin', 'translation');--> statement-breakpoint
CREATE TYPE "public"."derivative_outcome" AS ENUM('produced', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "draft_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"kind" "derivative_kind" NOT NULL,
	"outcome" "derivative_outcome" NOT NULL,
	"content" text,
	"asset_ref" text,
	"reason" text,
	"revision_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_derivatives_draft_kind_rev" UNIQUE("draft_id","kind","revision_no")
);
--> statement-breakpoint
ALTER TABLE "draft_derivatives" ADD CONSTRAINT "draft_derivatives_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;