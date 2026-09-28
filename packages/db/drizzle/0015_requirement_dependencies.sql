CREATE TABLE IF NOT EXISTS "requirement_dependencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL,
  "depends_on_requirement_id" uuid NOT NULL,
  "type" text DEFAULT 'blocks' NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requirement_dependencies_requirement_id_requirements_id_fk'
      AND conrelid = 'requirement_dependencies'::regclass
  ) THEN
    ALTER TABLE "requirement_dependencies"
      ADD CONSTRAINT "requirement_dependencies_requirement_id_requirements_id_fk"
      FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requirement_dependencies_depends_on_requirement_id_requirements_id_fk'
      AND conrelid = 'requirement_dependencies'::regclass
  ) THEN
    ALTER TABLE "requirement_dependencies"
      ADD CONSTRAINT "requirement_dependencies_depends_on_requirement_id_requirements_id_fk"
      FOREIGN KEY ("depends_on_requirement_id") REFERENCES "requirements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_requirement_deps_unique" ON "requirement_dependencies" USING btree ("requirement_id", "depends_on_requirement_id", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_deps_requirement" ON "requirement_dependencies" USING btree ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_deps_depends_on" ON "requirement_dependencies" USING btree ("depends_on_requirement_id");
