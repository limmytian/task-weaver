ALTER TABLE "task_weaver"."auth_actors" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "task_weaver"."auth_actors" ADD CONSTRAINT "auth_actors_deleted_check" CHECK ("deleted_at" IS NULL OR ("type" = 'agent' AND "status" = 'disabled'));
--> statement-breakpoint
CREATE INDEX "auth_actors_lifecycle_idx" ON "task_weaver"."auth_actors" ("managed_by_actor_id", "status", "deleted_at", "created_at", "id");
