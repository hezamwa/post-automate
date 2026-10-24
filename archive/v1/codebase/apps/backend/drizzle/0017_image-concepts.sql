ALTER TABLE "pipeline_runs" ADD COLUMN "image_concepts" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "chosen_image_concept" text;