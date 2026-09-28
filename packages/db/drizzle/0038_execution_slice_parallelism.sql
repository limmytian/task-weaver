ALTER TABLE "task_weaver"."execution_slices"
  ADD COLUMN IF NOT EXISTS "allow_parallel" boolean DEFAULT false NOT NULL;
