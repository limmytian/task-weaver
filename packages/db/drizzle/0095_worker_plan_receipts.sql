CREATE TABLE "task_weaver"."worker_plan_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL REFERENCES "task_weaver"."worker_attempts"("id") ON DELETE RESTRICT,
  "operation_key" uuid NOT NULL,
  "draft_id" uuid NOT NULL REFERENCES "task_weaver"."plan_drafts"("id") ON DELETE RESTRICT,
  "plan_digest" text NOT NULL,
  "resulting_revision" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_plan_operation" ON "task_weaver"."worker_plan_receipts" ("project_id", "operation_key");
