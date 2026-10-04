-- 0047_ti_agent_overhaul.sql
-- Drop legacy pi_* tables and foreign keys cleanly, recreate canonical ti_agent_* schemas

-- 1. Clean up references to pi_agent_runs in agent_usage_runs and assistant_messages
ALTER TABLE "task_weaver"."agent_usage_runs" DROP CONSTRAINT IF EXISTS "agent_usage_runs_pi_run_id_pi_agent_runs_id_fk";
DROP INDEX IF EXISTS "task_weaver"."idx_agent_usage_pi_attempt";
ALTER TABLE "task_weaver"."agent_usage_runs" DROP COLUMN IF EXISTS "pi_run_id";

ALTER TABLE "task_weaver"."assistant_messages" DROP CONSTRAINT IF EXISTS "assistant_messages_pi_agent_run_id_pi_agent_runs_id_fk";
DROP INDEX IF EXISTS "task_weaver"."idx_assistant_messages_pi_run";
ALTER TABLE "task_weaver"."assistant_messages" DROP COLUMN IF EXISTS "pi_agent_run_id";

-- 2. Drop legacy pi_* tables
DROP TABLE IF EXISTS "task_weaver"."pi_agent_runs" CASCADE;
DROP TABLE IF EXISTS "task_weaver"."pi_agent_policies" CASCADE;
DROP TABLE IF EXISTS "task_weaver"."pi_agent_model_configs" CASCADE;

-- 3. Clean up legacy pi columns from tasks, schedules, and schedule_runs
ALTER TABLE "task_weaver"."tasks" DROP COLUMN IF EXISTS "requested_pi_provider";
ALTER TABLE "task_weaver"."tasks" DROP COLUMN IF EXISTS "requested_pi_model";
ALTER TABLE "task_weaver"."tasks" ADD COLUMN IF NOT EXISTS "requested_provider" text;
ALTER TABLE "task_weaver"."tasks" ADD COLUMN IF NOT EXISTS "requested_model" text;

ALTER TABLE "task_weaver"."schedules" DROP COLUMN IF EXISTS "requested_pi_provider";
ALTER TABLE "task_weaver"."schedules" DROP COLUMN IF EXISTS "requested_pi_model";
ALTER TABLE "task_weaver"."schedules" ADD COLUMN IF NOT EXISTS "requested_provider" text;
ALTER TABLE "task_weaver"."schedules" ADD COLUMN IF NOT EXISTS "requested_model" text;

ALTER TABLE "task_weaver"."schedule_runs" DROP COLUMN IF EXISTS "requested_pi_provider";
ALTER TABLE "task_weaver"."schedule_runs" DROP COLUMN IF EXISTS "requested_pi_model";
ALTER TABLE "task_weaver"."schedule_runs" DROP COLUMN IF EXISTS "actual_pi_provider";
ALTER TABLE "task_weaver"."schedule_runs" DROP COLUMN IF EXISTS "actual_pi_model";
ALTER TABLE "task_weaver"."schedule_runs" ADD COLUMN IF NOT EXISTS "requested_provider" text;
ALTER TABLE "task_weaver"."schedule_runs" ADD COLUMN IF NOT EXISTS "requested_model" text;
ALTER TABLE "task_weaver"."schedule_runs" ADD COLUMN IF NOT EXISTS "actual_provider" text;
ALTER TABLE "task_weaver"."schedule_runs" ADD COLUMN IF NOT EXISTS "actual_model" text;

-- 4. Create canonical ti_agent_model_configs table
CREATE TABLE IF NOT EXISTS "task_weaver"."ti_agent_model_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" text NOT NULL,
  "owner_type" "task_weaver"."actor_type" NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "base_url" text,
  "label" text,
  "api_key_ref" text,
  "credential_status" text DEFAULT 'unknown' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "is_default_chat" boolean DEFAULT false NOT NULL,
  "is_default_agent" boolean DEFAULT false NOT NULL,
  "capabilities" text[],
  "cost_metadata" jsonb,
  "availability_checked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ti_model_configs_owner_provider_model"
  ON "task_weaver"."ti_agent_model_configs" ("owner_id", "owner_type", "provider", "model");
CREATE INDEX IF NOT EXISTS "idx_ti_model_configs_owner"
  ON "task_weaver"."ti_agent_model_configs" ("owner_id", "owner_type");
CREATE INDEX IF NOT EXISTS "idx_ti_model_configs_enabled"
  ON "task_weaver"."ti_agent_model_configs" ("enabled");

-- 5. Create canonical ti_agent_runs table
CREATE TABLE IF NOT EXISTS "task_weaver"."ti_agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid REFERENCES "task_weaver"."tasks"("id") ON DELETE SET NULL,
  "schedule_run_id" uuid REFERENCES "task_weaver"."schedule_runs"("id") ON DELETE SET NULL,
  "assigned_agent_id" text DEFAULT 'task-weaver:ti-agent' NOT NULL,
  "assigned_agent_type" "task_weaver"."actor_type" DEFAULT 'agent' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "lease_owner_id" text,
  "lease_owner_type" "task_weaver"."actor_type",
  "lease_expires_at" timestamp with time zone,
  "requested_provider" text,
  "requested_model" text,
  "actual_provider" text,
  "actual_model" text,
  "fallback_reason" text,
  "sandbox_session_id" text,
  "workspace_policy" text DEFAULT 'ephemeral' NOT NULL,
  "event_log" jsonb,
  "output_summary" text,
  "error_message" text,
  "token_usage_id" uuid,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "max_retries" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "cost_metadata" jsonb,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_task" ON "task_weaver"."ti_agent_runs" ("task_id");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_schedule_run" ON "task_weaver"."ti_agent_runs" ("schedule_run_id");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_assigned" ON "task_weaver"."ti_agent_runs" ("assigned_agent_id", "assigned_agent_type");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_status" ON "task_weaver"."ti_agent_runs" ("status");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_lease" ON "task_weaver"."ti_agent_runs" ("lease_expires_at");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_runs_retry" ON "task_weaver"."ti_agent_runs" ("status", "next_attempt_at");

-- 6. Create canonical ti_agent_policies table
CREATE TABLE IF NOT EXISTS "task_weaver"."ti_agent_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" text NOT NULL,
  "owner_type" "task_weaver"."actor_type" NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "execution_mode" text DEFAULT 'disabled' NOT NULL,
  "max_concurrent_runs" integer DEFAULT 1 NOT NULL,
  "daily_run_limit" integer DEFAULT 25 NOT NULL,
  "monthly_run_limit" integer DEFAULT 500 NOT NULL,
  "run_timeout_seconds" integer DEFAULT 600 NOT NULL,
  "default_max_retries" integer DEFAULT 0 NOT NULL,
  "sandbox_template" text,
  "allow_network" boolean DEFAULT false NOT NULL,
  "allowed_tools" text[],
  "denied_tools" text[],
  "assistant_auto_enabled" boolean DEFAULT false NOT NULL,
  "assistant_auto_mode" text DEFAULT 'disabled' NOT NULL,
  "assistant_action_allowlist" text[],
  "assistant_daily_action_limit" integer DEFAULT 10 NOT NULL,
  "assistant_run_timeout_seconds" integer DEFAULT 300 NOT NULL,
  "assistant_default_max_retries" integer DEFAULT 0 NOT NULL,
  "assistant_uncertain_to_review" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ti_agent_policies_owner"
  ON "task_weaver"."ti_agent_policies" ("owner_id", "owner_type");
CREATE INDEX IF NOT EXISTS "idx_ti_agent_policies_enabled"
  ON "task_weaver"."ti_agent_policies" ("enabled");

-- 7. Add ti_run_id to agent_usage_runs and ti_agent_run_id to assistant_messages
ALTER TABLE "task_weaver"."agent_usage_runs"
  ADD COLUMN IF NOT EXISTS "ti_run_id" uuid REFERENCES "task_weaver"."ti_agent_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_usage_ti_attempt"
  ON "task_weaver"."agent_usage_runs" ("ti_run_id", "attempt");

ALTER TABLE "task_weaver"."assistant_messages"
  ADD COLUMN IF NOT EXISTS "ti_agent_run_id" uuid REFERENCES "task_weaver"."ti_agent_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_messages_ti_run"
  ON "task_weaver"."assistant_messages" ("ti_agent_run_id");
