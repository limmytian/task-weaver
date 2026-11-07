ALTER TABLE "task_weaver"."thin_workers" ADD COLUMN "activity" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_workers" ADD COLUMN "activity_reason" text;
--> statement-breakpoint
ALTER TABLE "task_weaver"."thin_workers" ADD COLUMN "retry_at" timestamp with time zone;
