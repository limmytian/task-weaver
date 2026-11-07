ALTER TABLE "task_weaver"."projects" ADD COLUMN "worker_mode" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_weaver"."projects" ADD CONSTRAINT "projects_worker_mode_check" CHECK ("worker_mode" IN ('legacy', 'thin'));
