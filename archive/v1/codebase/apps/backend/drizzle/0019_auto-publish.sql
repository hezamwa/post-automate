ALTER TABLE "drafts" ADD COLUMN "auto_publish_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "auto_publish_held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_limits" ADD COLUMN "auto_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The flag moves to user_limits (spec §5.2): carry the current value over before dropping.
UPDATE "user_limits" l SET "auto_publish" = u."auto_publish" FROM "users" u WHERE u."id" = l."user_id";--> statement-breakpoint
INSERT INTO "user_limits" ("user_id", "auto_publish") SELECT "id", "auto_publish" FROM "users" u WHERE "auto_publish" = true AND NOT EXISTS (SELECT 1 FROM "user_limits" WHERE "user_id" = u."id");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auto_publish";