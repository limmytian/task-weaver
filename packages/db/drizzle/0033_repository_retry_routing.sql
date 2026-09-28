ALTER TABLE "task_weaver"."requirement_repositories"
  ADD COLUMN IF NOT EXISTS "retry_phase" text,
  ADD COLUMN IF NOT EXISTS "retry_role" text,
  ADD COLUMN IF NOT EXISTS "resume_operation" text,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_requirement_repositories_retry_queue"
  ON "task_weaver"."requirement_repositories" ("retry_role", "next_attempt_at", "delivery_status");
