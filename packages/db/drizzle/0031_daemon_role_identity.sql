DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'daemon_role'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."daemon_role" AS ENUM ('executor', 'reviewer', 'merger');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "daemons"
  ADD COLUMN IF NOT EXISTS "role" "task_weaver"."daemon_role" DEFAULT 'executor' NOT NULL,
  ADD COLUMN IF NOT EXISTS "actor_id" text,
  ADD COLUMN IF NOT EXISTS "actor_type" "task_weaver"."actor_type",
  ADD COLUMN IF NOT EXISTS "host" text,
  ADD COLUMN IF NOT EXISTS "process_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "worker_capacity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "daemons"
SET "process_started_at" = "created_at"
WHERE "process_started_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemons_role" ON "daemons" USING btree ("role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daemons_actor" ON "daemons" USING btree ("actor_id");
