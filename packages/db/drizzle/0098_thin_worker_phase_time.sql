ALTER TABLE "task_weaver"."thin_workers" ADD COLUMN "activity_changed_at" timestamp with time zone DEFAULT now() NOT NULL;
