DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_kind'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_kind" AS ENUM ('one_off', 'recurring');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_target_scope'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_target_scope" AS ENUM ('project', 'personal');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_recurrence_syntax'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_recurrence_syntax" AS ENUM ('rrule', 'cron');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_status'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_status" AS ENUM ('active', 'paused', 'archived');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_run_status'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_run_status" AS ENUM ('pending', 'created', 'skipped', 'failed', 'cancelled');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "requirement_id" uuid,
  "target_scope" "task_weaver"."schedule_target_scope" DEFAULT 'project' NOT NULL,
  "kind" "task_weaver"."schedule_kind" NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" "task_weaver"."schedule_status" DEFAULT 'active' NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "recurrence_syntax" "task_weaver"."schedule_recurrence_syntax",
  "recurrence_rule" text,
  "task_title" text NOT NULL,
  "task_description" text,
  "task_priority" "task_weaver"."task_priority" DEFAULT 'medium' NOT NULL,
  "auto_run" boolean DEFAULT false NOT NULL,
  "assigned_executor" text,
  "assigned_executor_type" "task_weaver"."actor_type",
  "requested_pi_provider" text,
  "requested_pi_model" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedules_project_id_projects_id_fk'
      AND conrelid = 'schedules'::regclass
  ) THEN
    ALTER TABLE "schedules"
      ADD CONSTRAINT "schedules_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedules_requirement_id_requirements_id_fk'
      AND conrelid = 'schedules'::regclass
  ) THEN
    ALTER TABLE "schedules"
      ADD CONSTRAINT "schedules_requirement_id_requirements_id_fk"
      FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL,
  "planned_for" timestamp with time zone NOT NULL,
  "status" "task_weaver"."schedule_run_status" DEFAULT 'pending' NOT NULL,
  "generated_task_id" uuid,
  "skipped_reason" text,
  "error_message" text,
  "requested_pi_provider" text,
  "requested_pi_model" text,
  "actual_pi_provider" text,
  "actual_pi_model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedule_runs_schedule_id_schedules_id_fk'
      AND conrelid = 'schedule_runs'::regclass
  ) THEN
    ALTER TABLE "schedule_runs"
      ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk"
      FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedule_runs_generated_task_id_tasks_id_fk'
      AND conrelid = 'schedule_runs'::regclass
  ) THEN
    ALTER TABLE "schedule_runs"
      ADD CONSTRAINT "schedule_runs_generated_task_id_tasks_id_fk"
      FOREIGN KEY ("generated_task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_project" ON "schedules" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_requirement" ON "schedules" USING btree ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_status_next_run" ON "schedules" USING btree ("status", "next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_target_scope" ON "schedules" USING btree ("target_scope");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_schedule_runs_schedule_planned_for" ON "schedule_runs" USING btree ("schedule_id", "planned_for");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_schedule_runs_generated_task" ON "schedule_runs" USING btree ("generated_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_schedule" ON "schedule_runs" USING btree ("schedule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_status" ON "schedule_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_planned_for" ON "schedule_runs" USING btree ("planned_for");
