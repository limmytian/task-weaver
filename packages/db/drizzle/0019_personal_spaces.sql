DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'task_scope'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."task_scope" AS ENUM ('project', 'personal');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "scope" "task_weaver"."task_scope" DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "personal_owner_id" text;
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "personal_owner_type" "task_weaver"."actor_type";
--> statement-breakpoint
ALTER TABLE "tasks"
  ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks"
  ALTER COLUMN "requirement_id" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_scope_integrity'
  ) THEN
    ALTER TABLE "tasks"
      ADD CONSTRAINT "tasks_scope_integrity" CHECK (
        (
          "scope" = 'project'
          AND "project_id" IS NOT NULL
          AND "requirement_id" IS NOT NULL
          AND "personal_owner_id" IS NULL
          AND "personal_owner_type" IS NULL
        )
        OR (
          "scope" = 'personal'
          AND "project_id" IS NULL
          AND "requirement_id" IS NULL
          AND "personal_owner_id" IS NOT NULL
          AND "personal_owner_type" IS NOT NULL
        )
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_scope" ON "tasks" ("scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_personal_owner" ON "tasks" ("personal_owner_id", "personal_owner_type");
--> statement-breakpoint
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "personal_owner_id" text;
--> statement-breakpoint
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "personal_owner_type" "task_weaver"."actor_type";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_scope_integrity'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_scope_integrity" CHECK (
        ("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
        OR ("project_id" IS NULL AND "personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_docs_personal_owner" ON "documents" ("personal_owner_id", "personal_owner_type");
--> statement-breakpoint
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "personal_owner_id" text;
--> statement-breakpoint
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "personal_owner_type" "task_weaver"."actor_type";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_scope_integrity'
  ) THEN
    ALTER TABLE "memories"
      ADD CONSTRAINT "memories_scope_integrity" CHECK (
        ("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
        OR ("project_id" IS NULL AND "personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_personal_owner" ON "memories" ("personal_owner_id", "personal_owner_type");
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "personal_owner_id" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "personal_owner_type" "task_weaver"."actor_type";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_scope_integrity'
  ) THEN
    ALTER TABLE "mcp_servers"
      ADD CONSTRAINT "mcp_servers_scope_integrity" CHECK (
        ("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
        OR ("project_id" IS NULL AND "personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_servers_personal_owner" ON "mcp_servers" ("personal_owner_id", "personal_owner_type");
