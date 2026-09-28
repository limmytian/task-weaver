ALTER TABLE "task_weaver"."requirement_repositories"
  ADD COLUMN IF NOT EXISTS "operation_checkpoints" jsonb DEFAULT '{}'::jsonb NOT NULL;
