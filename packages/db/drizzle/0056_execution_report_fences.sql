ALTER TABLE task_weaver.review_runs ADD COLUMN lease_run_id uuid;
--> statement-breakpoint
ALTER TABLE task_weaver.review_runs ADD COLUMN lease_generation integer;
--> statement-breakpoint
ALTER TABLE task_weaver.agent_usage_runs ADD COLUMN lease_run_id uuid;
--> statement-breakpoint
ALTER TABLE task_weaver.agent_usage_runs ADD COLUMN lease_generation integer;
--> statement-breakpoint
ALTER TABLE task_weaver.agent_usage_runs ADD COLUMN worker_index text;
--> statement-breakpoint
