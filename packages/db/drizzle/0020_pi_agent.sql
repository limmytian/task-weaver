CREATE TABLE IF NOT EXISTS "pi_agent_model_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL,
  "owner_type" "task_weaver"."actor_type" NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "label" text,
  "api_key_ref" text,
  "credential_status" text DEFAULT 'unknown' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "capabilities" text[],
  "cost_metadata" jsonb,
  "availability_checked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pi_model_configs_owner_provider_model"
  ON "pi_agent_model_configs" ("owner_id", "owner_type", "provider", "model");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pi_model_configs_one_default"
  ON "pi_agent_model_configs" ("owner_id", "owner_type")
  WHERE "is_default" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_model_configs_owner"
  ON "pi_agent_model_configs" ("owner_id", "owner_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_model_configs_enabled"
  ON "pi_agent_model_configs" ("enabled");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_model_configs_credential_status'
  ) THEN
    ALTER TABLE "pi_agent_model_configs"
      ADD CONSTRAINT "pi_model_configs_credential_status"
      CHECK ("credential_status" IN ('unknown', 'valid', 'invalid', 'missing'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pi_agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid,
  "schedule_run_id" uuid,
  "assigned_agent_id" text NOT NULL,
  "assigned_agent_type" "task_weaver"."actor_type" DEFAULT 'agent' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "lease_owner_id" text,
  "lease_owner_type" "task_weaver"."actor_type",
  "lease_expires_at" timestamp with time zone,
  "requested_pi_provider" text,
  "requested_pi_model" text,
  "actual_pi_provider" text,
  "actual_pi_model" text,
  "fallback_reason" text,
  "pi_session_id" text,
  "event_log" jsonb,
  "output_summary" text,
  "error_message" text,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "max_retries" integer DEFAULT 0 NOT NULL,
  "cost_metadata" jsonb,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_runs_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE "pi_agent_runs"
      ADD CONSTRAINT "pi_agent_runs_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_runs_schedule_run_id_schedule_runs_id_fk'
  ) THEN
    ALTER TABLE "pi_agent_runs"
      ADD CONSTRAINT "pi_agent_runs_schedule_run_id_schedule_runs_id_fk"
      FOREIGN KEY ("schedule_run_id") REFERENCES "schedule_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_runs_status'
  ) THEN
    ALTER TABLE "pi_agent_runs"
      ADD CONSTRAINT "pi_agent_runs_status"
      CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'in_review', 'cancelled'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_runs_target'
  ) THEN
    ALTER TABLE "pi_agent_runs"
      ADD CONSTRAINT "pi_agent_runs_target"
      CHECK ("task_id" IS NOT NULL OR "schedule_run_id" IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_task" ON "pi_agent_runs" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_schedule_run" ON "pi_agent_runs" ("schedule_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_assigned" ON "pi_agent_runs" ("assigned_agent_id", "assigned_agent_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_status" ON "pi_agent_runs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_lease" ON "pi_agent_runs" ("lease_expires_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_entity_type_check'
  ) THEN
    ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_entity_type_check";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_entity_type_check'
  ) THEN
    ALTER TABLE "activity_log"
      ADD CONSTRAINT "activity_log_entity_type_check"
      CHECK ("entity_type" IN (
        'project',
        'task',
        'document',
        'requirement',
        'schedule',
        'pi_agent_model_config',
        'pi_agent_run'
      ));
  END IF;
END $$;
