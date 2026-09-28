ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "requested_pi_provider" text;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "requested_pi_model" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pi_agent_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL,
  "owner_type" "task_weaver"."actor_type" NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "execution_mode" text DEFAULT 'disabled' NOT NULL,
  "max_concurrent_runs" integer DEFAULT 1 NOT NULL,
  "daily_run_limit" integer DEFAULT 25 NOT NULL,
  "monthly_run_limit" integer DEFAULT 500 NOT NULL,
  "run_timeout_seconds" integer DEFAULT 600 NOT NULL,
  "default_max_retries" integer DEFAULT 0 NOT NULL,
  "tool_allowlist" text[],
  "tool_denylist" text[],
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pi_agent_policies_owner"
  ON "pi_agent_policies" ("owner_id", "owner_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pi_agent_policies_enabled"
  ON "pi_agent_policies" ("enabled");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_policies_execution_mode'
  ) THEN
    ALTER TABLE "pi_agent_policies"
      ADD CONSTRAINT "pi_agent_policies_execution_mode"
      CHECK ("execution_mode" IN ('disabled', 'dry_run', 'live'));
  END IF;
END $$;
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
        'pi_agent_policy',
        'pi_agent_run'
      ));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_policies_limits'
  ) THEN
    ALTER TABLE "pi_agent_policies"
      ADD CONSTRAINT "pi_agent_policies_limits"
      CHECK (
        "max_concurrent_runs" >= 1
        AND "daily_run_limit" >= 0
        AND "monthly_run_limit" >= 0
        AND "run_timeout_seconds" >= 30
        AND "default_max_retries" >= 0
      );
  END IF;
END $$;
