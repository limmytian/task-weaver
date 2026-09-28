ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "control_state" text DEFAULT 'running' NOT NULL;

ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "control_reason" text;

ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "control_requested_at" timestamp with time zone;

ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "control_requested_by" text;

ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "control_requested_by_type" "task_weaver"."actor_type";

CREATE INDEX IF NOT EXISTS "idx_daemons_control_state"
  ON "task_weaver"."daemons" ("control_state");
