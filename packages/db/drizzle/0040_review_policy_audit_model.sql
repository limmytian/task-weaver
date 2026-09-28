CREATE TABLE IF NOT EXISTS "task_weaver"."review_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "requirement_id" uuid REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "required_checks" text[] DEFAULT '{}'::text[] NOT NULL,
  "require_ai_review" boolean DEFAULT false NOT NULL,
  "minimum_human_approvals" integer DEFAULT 0 NOT NULL,
  "require_independent_reviewer" boolean DEFAULT false NOT NULL,
  "require_independent_merger" boolean DEFAULT false NOT NULL,
  "allowed_merge_modes" text[] DEFAULT ARRAY['provider', 'direct', 'manual']::text[] NOT NULL,
  "default_merge_mode" text DEFAULT 'direct' NOT NULL,
  "base_branch" text DEFAULT 'main' NOT NULL,
  "retry_policy" jsonb DEFAULT '{"maxAttempts":3,"initialBackoffSeconds":30,"maxBackoffSeconds":900}'::jsonb NOT NULL,
  "allow_manual_override" boolean DEFAULT false NOT NULL,
  "override_requires_reason" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_policies_human_approvals_check" CHECK ("minimum_human_approvals" BETWEEN 0 AND 20),
  CONSTRAINT "review_policies_merge_modes_check" CHECK (
    cardinality("allowed_merge_modes") > 0
    AND "default_merge_mode" = ANY("allowed_merge_modes")
    AND "allowed_merge_modes" <@ ARRAY['provider', 'direct', 'manual']::text[]
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_policies_project_default"
  ON "task_weaver"."review_policies" ("project_id") WHERE "requirement_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_policies_requirement"
  ON "task_weaver"."review_policies" ("requirement_id") WHERE "requirement_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_review_policies_project"
  ON "task_weaver"."review_policies" ("project_id");

CREATE TABLE IF NOT EXISTS "task_weaver"."review_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "requirement_repository_id" uuid NOT NULL REFERENCES "task_weaver"."requirement_repositories"("id") ON DELETE CASCADE,
  "attempt" integer NOT NULL,
  "head_commit" text NOT NULL,
  "base_commit" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "executor_actor_id" text,
  "executor_actor_type" "task_weaver"."actor_type",
  "executor_daemon_id" uuid,
  "reviewer_actor_id" text NOT NULL,
  "reviewer_actor_type" "task_weaver"."actor_type" NOT NULL,
  "reviewer_daemon_id" uuid,
  "supersedes_run_id" uuid,
  "superseded_by_run_id" uuid,
  "summary" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_runs_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "review_runs_status_check" CHECK ("status" IN ('running', 'approved', 'changes_requested', 'blocked', 'failed', 'superseded')),
  CONSTRAINT "review_runs_supersedes_fk" FOREIGN KEY ("supersedes_run_id") REFERENCES "task_weaver"."review_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "review_runs_superseded_by_fk" FOREIGN KEY ("superseded_by_run_id") REFERENCES "task_weaver"."review_runs"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_runs_repository_attempt"
  ON "task_weaver"."review_runs" ("requirement_repository_id", "attempt");
CREATE INDEX IF NOT EXISTS "idx_review_runs_requirement_created"
  ON "task_weaver"."review_runs" ("requirement_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_review_runs_repository_head"
  ON "task_weaver"."review_runs" ("requirement_repository_id", "head_commit");
CREATE INDEX IF NOT EXISTS "idx_review_runs_status"
  ON "task_weaver"."review_runs" ("status");

CREATE TABLE IF NOT EXISTS "task_weaver"."review_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_run_id" uuid NOT NULL REFERENCES "task_weaver"."review_runs"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "provider" text DEFAULT 'local' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "external_url" text,
  "summary" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_checks_status_check" CHECK ("status" IN ('queued', 'running', 'passed', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_checks_run_name_provider"
  ON "task_weaver"."review_checks" ("review_run_id", "name", "provider");
CREATE INDEX IF NOT EXISTS "idx_review_checks_run_status"
  ON "task_weaver"."review_checks" ("review_run_id", "status");

CREATE TABLE IF NOT EXISTS "task_weaver"."review_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_run_id" uuid NOT NULL REFERENCES "task_weaver"."review_runs"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "detail" text NOT NULL,
  "path" text,
  "line" integer,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_findings_severity_check" CHECK ("severity" IN ('info', 'low', 'medium', 'high', 'critical')),
  CONSTRAINT "review_findings_status_check" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT "review_findings_line_check" CHECK ("line" IS NULL OR "line" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_review_findings_run_fingerprint"
  ON "task_weaver"."review_findings" ("review_run_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "idx_review_findings_run_status"
  ON "task_weaver"."review_findings" ("review_run_id", "status");

CREATE TABLE IF NOT EXISTS "task_weaver"."review_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_run_id" uuid NOT NULL REFERENCES "task_weaver"."review_runs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "decision" text NOT NULL,
  "head_commit" text NOT NULL,
  "actor_id" text NOT NULL,
  "actor_type" "task_weaver"."actor_type" NOT NULL,
  "daemon_id" uuid,
  "summary" text,
  "reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_decisions_kind_check" CHECK ("kind" IN ('ai', 'human', 'forge', 'override')),
  CONSTRAINT "review_decisions_decision_check" CHECK ("decision" IN ('approved', 'changes_requested', 'abstained', 'bypassed'))
);

CREATE INDEX IF NOT EXISTS "idx_review_decisions_run_kind"
  ON "task_weaver"."review_decisions" ("review_run_id", "kind");
CREATE INDEX IF NOT EXISTS "idx_review_decisions_run_commit"
  ON "task_weaver"."review_decisions" ("review_run_id", "head_commit");

ALTER TABLE "task_weaver"."requirement_repositories"
  ADD COLUMN IF NOT EXISTS "executor_actor_id" text,
  ADD COLUMN IF NOT EXISTS "executor_actor_type" "task_weaver"."actor_type",
  ADD COLUMN IF NOT EXISTS "executor_daemon_id" uuid,
  ADD COLUMN IF NOT EXISTS "reviewer_actor_id" text,
  ADD COLUMN IF NOT EXISTS "reviewer_actor_type" "task_weaver"."actor_type",
  ADD COLUMN IF NOT EXISTS "reviewer_daemon_id" uuid,
  ADD COLUMN IF NOT EXISTS "merger_actor_id" text,
  ADD COLUMN IF NOT EXISTS "merger_actor_type" "task_weaver"."actor_type",
  ADD COLUMN IF NOT EXISTS "merger_daemon_id" uuid;
