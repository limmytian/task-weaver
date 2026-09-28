DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'skill_package_status'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."skill_package_status" AS ENUM ('active', 'deprecated', 'archived', 'deleted');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'skill_package_version_status'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."skill_package_version_status" AS ENUM ('active', 'deprecated', 'archived', 'deleted');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'skill_package_source_type'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."skill_package_source_type" AS ENUM ('upload', 'directory', 'archive', 'single_file', 'seed', 'external');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'skill_package_file_kind'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."skill_package_file_kind" AS ENUM ('entry', 'text', 'asset', 'binary');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'skill_package_storage_object_kind'
      AND n.nspname = 'task_weaver'
  ) THEN
    CREATE TYPE "task_weaver"."skill_package_storage_object_kind" AS ENUM ('archive', 'file');
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "project_id" uuid,
  "personal_owner_id" text,
  "personal_owner_type" "task_weaver"."actor_type",
  "status" "task_weaver"."skill_package_status" DEFAULT 'active' NOT NULL,
  "source_type" "task_weaver"."skill_package_source_type" DEFAULT 'upload' NOT NULL,
  "entry_path" text DEFAULT 'SKILL.md' NOT NULL,
  "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" text,
  "keywords" text[],
  "tags" text[],
  "primary_document_id" uuid,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "skill_packages_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "skill_packages_primary_document_id_documents_id_fk"
    FOREIGN KEY ("primary_document_id") REFERENCES "documents"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "skill_packages_scope_check" CHECK (
    ("project_id" IS NULL OR ("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL))
    AND (
      ("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
      OR ("personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
    )
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_package_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_id" uuid NOT NULL,
  "version" text NOT NULL,
  "status" "task_weaver"."skill_package_version_status" DEFAULT 'active' NOT NULL,
  "source_type" "task_weaver"."skill_package_source_type" DEFAULT 'upload' NOT NULL,
  "entry_path" text DEFAULT 'SKILL.md' NOT NULL,
  "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "file_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "storage_backend" text DEFAULT 'local' NOT NULL,
  "storage_key_prefix" text,
  "file_count" integer DEFAULT 0 NOT NULL,
  "total_size_bytes" bigint DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_package_versions_package_id_skill_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "skill_packages"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "skill_package_versions_file_count_check" CHECK ("file_count" >= 0),
  CONSTRAINT "skill_package_versions_total_size_check" CHECK ("total_size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_package_storage_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_version_id" uuid NOT NULL,
  "kind" "task_weaver"."skill_package_storage_object_kind" DEFAULT 'file' NOT NULL,
  "storage_backend" text DEFAULT 'local' NOT NULL,
  "object_key" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "content_type" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_package_storage_objects_version_id_skill_package_versions_id_fk"
    FOREIGN KEY ("package_version_id") REFERENCES "skill_package_versions"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "skill_package_storage_objects_size_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "skill_package_storage_objects_sha_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_package_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_version_id" uuid NOT NULL,
  "storage_object_id" uuid,
  "path" text NOT NULL,
  "kind" "task_weaver"."skill_package_file_kind" NOT NULL,
  "content_type" text,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "is_readable_text" boolean DEFAULT false NOT NULL,
  "is_executable" boolean DEFAULT false NOT NULL,
  "indexed_document_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_package_files_version_id_skill_package_versions_id_fk"
    FOREIGN KEY ("package_version_id") REFERENCES "skill_package_versions"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "skill_package_files_storage_object_id_skill_package_storage_objects_id_fk"
    FOREIGN KEY ("storage_object_id") REFERENCES "skill_package_storage_objects"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "skill_package_files_indexed_document_id_documents_id_fk"
    FOREIGN KEY ("indexed_document_id") REFERENCES "documents"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "skill_package_files_path_check" CHECK (
    "path" <> ''
    AND "path" !~ '^/'
    AND "path" !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT "skill_package_files_size_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "skill_package_files_sha_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_packages_project" ON "skill_packages" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_packages_personal_owner" ON "skill_packages" USING btree ("personal_owner_id", "personal_owner_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_packages_status" ON "skill_packages" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_packages_primary_document" ON "skill_packages" USING btree ("primary_document_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_packages_global_name_unique"
  ON "skill_packages" (lower("name"))
  WHERE "project_id" IS NULL AND "personal_owner_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_packages_project_name_unique"
  ON "skill_packages" ("project_id", lower("name"))
  WHERE "project_id" IS NOT NULL AND "personal_owner_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_packages_personal_name_unique"
  ON "skill_packages" ("personal_owner_id", "personal_owner_type", lower("name"))
  WHERE "project_id" IS NULL AND "personal_owner_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_package_versions_package_version"
  ON "skill_package_versions" USING btree ("package_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_versions_package" ON "skill_package_versions" USING btree ("package_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_versions_status" ON "skill_package_versions" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_package_storage_object_key"
  ON "skill_package_storage_objects" USING btree ("storage_backend", "object_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_storage_objects_version"
  ON "skill_package_storage_objects" USING btree ("package_version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_storage_objects_sha"
  ON "skill_package_storage_objects" USING btree ("sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_package_files_version_path"
  ON "skill_package_files" USING btree ("package_version_id", "path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_files_version" ON "skill_package_files" USING btree ("package_version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_files_storage_object" ON "skill_package_files" USING btree ("storage_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_files_indexed_document" ON "skill_package_files" USING btree ("indexed_document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_package_files_sha" ON "skill_package_files" USING btree ("sha256");
