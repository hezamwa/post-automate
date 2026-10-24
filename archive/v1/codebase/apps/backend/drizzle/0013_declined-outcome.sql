ALTER TYPE "public"."derivative_outcome" ADD VALUE 'declined';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "channels" jsonb;