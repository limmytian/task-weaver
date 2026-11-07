CREATE TABLE "task_weaver"."thin_git_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "task_weaver"."repositories"("id") ON DELETE RESTRICT,
  "attempt_id" uuid NOT NULL REFERENCES "task_weaver"."worker_attempts"("id") ON DELETE RESTRICT,
  "operation_key" uuid NOT NULL,
  "target_branch" text NOT NULL,
  "expected_head" text NOT NULL,
  "proposed_head" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('prepared', 'pushing', 'confirmed', 'uncertain', 'abandoned')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_thin_git_delivery_operation" ON "task_weaver"."thin_git_deliveries" ("project_id", "operation_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_thin_git_delivery_active_branch" ON "task_weaver"."thin_git_deliveries" ("repository_id", "target_branch") WHERE "state" IN ('prepared', 'pushing', 'uncertain');
