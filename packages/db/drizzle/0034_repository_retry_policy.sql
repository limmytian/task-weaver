ALTER TABLE "task_weaver"."requirement_repositories"
  ADD COLUMN IF NOT EXISTS "retry_policy" text;
