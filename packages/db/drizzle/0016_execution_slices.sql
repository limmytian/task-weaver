DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'model_tier'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."model_tier" AS ENUM ('fast', 'standard', 'strong');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'execution_slice_status'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."execution_slice_status" AS ENUM ('todo', 'in_progress', 'in_review', 'done', 'cancelled');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "requirements"
  ADD COLUMN IF NOT EXISTS "model_tier" "task_weaver"."model_tier" DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_slices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "order_index" integer DEFAULT 0 NOT NULL,
  "model_tier" "task_weaver"."model_tier" DEFAULT 'standard' NOT NULL,
  "status" "task_weaver"."execution_slice_status" DEFAULT 'todo' NOT NULL,
  "result_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'execution_slices_requirement_id_requirements_id_fk'
      AND conrelid = 'execution_slices'::regclass
  ) THEN
    ALTER TABLE "execution_slices"
      ADD CONSTRAINT "execution_slices_requirement_id_requirements_id_fk"
      FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_slices_requirement" ON "execution_slices" USING btree ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_slices_status" ON "execution_slices" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_execution_slices_requirement_order" ON "execution_slices" USING btree ("requirement_id", "order_index");
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "execution_slice_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tasks_execution_slice_id_execution_slices_id_fk'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE "tasks"
      ADD CONSTRAINT "tasks_execution_slice_id_execution_slices_id_fk"
      FOREIGN KEY ("execution_slice_id") REFERENCES "execution_slices"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_execution_slice" ON "tasks" USING btree ("execution_slice_id");
