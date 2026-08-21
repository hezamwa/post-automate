CREATE TYPE "public"."blog_type" AS ENUM('public', 'em');--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "blog_type" "blog_type";