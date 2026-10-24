DROP INDEX "ai_routes_user_task_priority";--> statement-breakpoint
ALTER TABLE "ai_routes" ADD CONSTRAINT "ai_routes_user_task_priority" UNIQUE NULLS NOT DISTINCT("user_id","task_type","priority");