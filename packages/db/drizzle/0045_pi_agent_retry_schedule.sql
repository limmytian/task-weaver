ALTER TABLE "task_weaver"."pi_agent_runs"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_pi_agent_runs_retry"
  ON "task_weaver"."pi_agent_runs" USING btree ("status", "next_attempt_at");
