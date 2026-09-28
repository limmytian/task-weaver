ALTER TABLE "task_weaver"."daemons"
  DROP COLUMN IF EXISTS "current_task_id",
  ADD COLUMN "active_task_ids" uuid[] NOT NULL DEFAULT '{}';
