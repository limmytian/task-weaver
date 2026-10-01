CREATE TABLE "task_weaver"."agent_usage_runs" (
  "process_id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "requirement_id" uuid NOT NULL REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "task_weaver"."tasks"("id") ON DELETE SET NULL,
  "daemon_id" uuid REFERENCES "task_weaver"."daemons"("id") ON DELETE SET NULL,
  "pi_run_id" uuid REFERENCES "task_weaver"."pi_agent_runs"("id") ON DELETE SET NULL,
  "attempt" integer,
  "source" text NOT NULL,
  "agent" text NOT NULL,
  "phase" text NOT NULL,
  "outcome" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "revision" bigint NOT NULL,
  "summary" jsonb NOT NULL,
  "reported_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_usage_project_time" ON "task_weaver"."agent_usage_runs" ("project_id", "started_at");
CREATE INDEX "idx_agent_usage_requirement" ON "task_weaver"."agent_usage_runs" ("requirement_id");
CREATE INDEX "idx_agent_usage_task" ON "task_weaver"."agent_usage_runs" ("task_id");
CREATE INDEX "idx_agent_usage_pi_attempt" ON "task_weaver"."agent_usage_runs" ("pi_run_id", "attempt");
