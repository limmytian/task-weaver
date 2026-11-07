CREATE TABLE "task_weaver"."worker_acceptance_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL REFERENCES "task_weaver"."worker_attempts"("id") ON DELETE RESTRICT,
  "repository_id" uuid NOT NULL REFERENCES "task_weaver"."repositories"("id") ON DELETE RESTRICT,
  "branch" text NOT NULL,
  "commit" text NOT NULL CHECK ("commit" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  "repository_identity" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_acceptance_snapshot_attempt_repository" ON "task_weaver"."worker_acceptance_snapshots" ("attempt_id", "repository_id");
