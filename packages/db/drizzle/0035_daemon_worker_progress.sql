CREATE TABLE IF NOT EXISTS "task_weaver"."daemon_worker_progress" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "daemon_id" uuid NOT NULL REFERENCES "task_weaver"."daemons"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL,
  "worker_index" integer NOT NULL,
  "role" "task_weaver"."daemon_role" NOT NULL,
  "requirement_id" uuid NOT NULL REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "execution_slice_id" uuid REFERENCES "task_weaver"."execution_slices"("id") ON DELETE SET NULL,
  "current_task_id" uuid REFERENCES "task_weaver"."tasks"("id") ON DELETE SET NULL,
  "phase" text NOT NULL,
  "message" text,
  "lease_generation" integer NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_daemon_worker_progress_worker_unique"
  ON "task_weaver"."daemon_worker_progress" ("daemon_id", "worker_index");
CREATE INDEX IF NOT EXISTS "idx_daemon_worker_progress_requirement"
  ON "task_weaver"."daemon_worker_progress" ("requirement_id", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_daemon_worker_progress_run"
  ON "task_weaver"."daemon_worker_progress" ("run_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_weaver"."daemon_worker_progress_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "daemon_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "worker_index" integer NOT NULL,
  "role" "task_weaver"."daemon_role" NOT NULL,
  "requirement_id" uuid NOT NULL,
  "execution_slice_id" uuid,
  "current_task_id" uuid,
  "phase" text NOT NULL,
  "message" text,
  "source" text NOT NULL,
  "lease_generation" integer NOT NULL,
  "version" integer NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemon_worker_progress_history_run"
  ON "task_weaver"."daemon_worker_progress_history" ("run_id", "version");
CREATE INDEX IF NOT EXISTS "idx_daemon_worker_progress_history_requirement"
  ON "task_weaver"."daemon_worker_progress_history" ("requirement_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_daemon_worker_progress_history_task"
  ON "task_weaver"."daemon_worker_progress_history" ("current_task_id", "occurred_at");
