ALTER TABLE "task_weaver"."requirement_repositories"
  ADD COLUMN IF NOT EXISTS "merge_mode" text,
  ADD COLUMN IF NOT EXISTS "manual_action_url" text,
  ADD COLUMN IF NOT EXISTS "external_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "external_state_updated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "external_sync_revision" integer DEFAULT 0 NOT NULL;

ALTER TABLE "task_weaver"."requirement_repositories"
  DROP CONSTRAINT IF EXISTS "requirement_repositories_merge_mode_check";
ALTER TABLE "task_weaver"."requirement_repositories"
  ADD CONSTRAINT "requirement_repositories_merge_mode_check"
  CHECK ("merge_mode" IS NULL OR "merge_mode" IN ('provider', 'direct', 'manual'));

CREATE INDEX IF NOT EXISTS "idx_requirement_repositories_manual_merge"
  ON "task_weaver"."requirement_repositories" ("merge_mode", "delivery_status")
  WHERE "merge_mode" = 'manual';
