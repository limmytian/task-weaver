CREATE TABLE "task_weaver"."worker_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "requirement_id" uuid NOT NULL REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "task_weaver"."tasks"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "worker_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "plan_revision" integer NOT NULL,
  "status" text DEFAULT 'running' NOT NULL CHECK ("status" IN ('running', 'completed', 'attention', 'resolved')),
  "expires_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "result_key" uuid,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_worker_attempt_task" ON "task_weaver"."worker_attempts" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_worker_attempt_project_status" ON "task_weaver"."worker_attempts" ("project_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_attempt_unresolved_task" ON "task_weaver"."worker_attempts" ("task_id") WHERE "status" IN ('running', 'attention');
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_attempt_running_worker" ON "task_weaver"."worker_attempts" ("worker_id") WHERE "status" = 'running';
--> statement-breakpoint
ALTER TABLE "task_weaver"."workflow_outputs" ADD COLUMN "worker_attempt_id" uuid REFERENCES "task_weaver"."worker_attempts"("id") ON DELETE RESTRICT;
