DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'schedule_catch_up_policy'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."schedule_catch_up_policy" AS ENUM ('none', 'latest', 'all');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "schedules"
  ADD COLUMN IF NOT EXISTS "catch_up_policy" "task_weaver"."schedule_catch_up_policy" DEFAULT 'latest' NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules"
  ADD COLUMN IF NOT EXISTS "expiry_window_minutes" integer;
--> statement-breakpoint
ALTER TABLE "schedules"
  ADD COLUMN IF NOT EXISTS "max_catch_up_runs" integer;
