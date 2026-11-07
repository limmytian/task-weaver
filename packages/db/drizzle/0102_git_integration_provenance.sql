ALTER TABLE "task_weaver"."thin_git_deliveries" ADD COLUMN "purpose" text NOT NULL DEFAULT 'task' CHECK ("purpose" IN ('task', 'integration'));
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_git_deliveries" ADD COLUMN "acceptance_attempt_id" uuid REFERENCES "task_weaver"."worker_attempts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_git_deliveries" ADD COLUMN "accepted_commit" text;
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_git_deliveries" ADD COLUMN "source_branch" text;
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_git_deliveries" ADD CONSTRAINT "thin_git_delivery_provenance_check" CHECK (
  ("purpose" = 'task' AND "acceptance_attempt_id" IS NULL AND "accepted_commit" IS NULL AND "source_branch" IS NULL)
  OR
  ("purpose" = 'integration' AND "acceptance_attempt_id" IS NOT NULL AND "accepted_commit" IS NOT NULL AND "accepted_commit" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND "source_branch" IS NOT NULL AND "source_branch" <> "target_branch")
);
