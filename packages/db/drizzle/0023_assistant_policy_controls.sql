ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_auto_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_auto_mode" text DEFAULT 'disabled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_action_allowlist" text[];
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_daily_action_limit" integer DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_run_timeout_seconds" integer DEFAULT 300 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_default_max_retries" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pi_agent_policies"
  ADD COLUMN IF NOT EXISTS "assistant_uncertain_to_review" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_policies_assistant_auto_mode'
  ) THEN
    ALTER TABLE "pi_agent_policies"
      ADD CONSTRAINT "pi_agent_policies_assistant_auto_mode"
      CHECK ("assistant_auto_mode" IN ('disabled', 'dry_run', 'live'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pi_agent_policies_assistant_limits'
  ) THEN
    ALTER TABLE "pi_agent_policies"
      ADD CONSTRAINT "pi_agent_policies_assistant_limits"
      CHECK (
        "assistant_daily_action_limit" >= 0
        AND "assistant_run_timeout_seconds" >= 30
        AND "assistant_default_max_retries" >= 0
      );
  END IF;
END $$;
