CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "provider" text DEFAULT 'generic' NOT NULL,
  "provider_external_id" text,
  "host" text NOT NULL,
  "namespace" text NOT NULL,
  "name" text NOT NULL,
  "canonical_key" text NOT NULL,
  "web_url" text,
  "https_clone_url" text,
  "ssh_clone_url" text,
  "default_branch" text,
  "status" text DEFAULT 'active' NOT NULL,
  "tags" text[],
  "visibility" text DEFAULT 'instance' NOT NULL,
  "owner_id" text,
  "owner_type" "task_weaver"."actor_type",
  "auth_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repositories_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "repositories_visibility_check" CHECK ("visibility" IN ('instance', 'restricted', 'private')),
  CONSTRAINT "repositories_owner_check" CHECK (
    ("visibility" = 'instance' AND "owner_id" IS NULL AND "owner_type" IS NULL)
    OR ("visibility" <> 'instance' AND "owner_id" IS NOT NULL AND "owner_type" IS NOT NULL)
  ),
  CONSTRAINT "repositories_canonical_key_check" CHECK ("canonical_key" = lower("canonical_key")),
  CONSTRAINT "repositories_web_url_no_credentials" CHECK ("web_url" IS NULL OR "web_url" !~ '://[^/@]+:[^/@]+@'),
  CONSTRAINT "repositories_https_url_no_credentials" CHECK ("https_clone_url" IS NULL OR "https_clone_url" !~ '://[^/@]+:[^/@]+@')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_repositories_canonical_key_unique" ON "repositories" ("canonical_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_repositories_provider_external_unique" ON "repositories" ("provider", "provider_external_id") WHERE "provider_external_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_status_updated" ON "repositories" ("status", "updated_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_provider_status" ON "repositories" ("provider", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_host_status" ON "repositories" ("host", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_visibility" ON "repositories" ("visibility", "owner_id", "owner_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_tags_gin" ON "repositories" USING gin ("tags");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_canonical_trgm" ON "repositories" USING gin ("canonical_key" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repositories_display_name_trgm" ON "repositories" USING gin ("display_name" gin_trgm_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "base_branch" text,
  "working_branch" text,
  "workspace_key" text,
  "manifest_version" integer,
  "provisioned_at" timestamp with time zone,
  "head_commit" text,
  "pushed_commit" text,
  "push_status" text DEFAULT 'pending' NOT NULL,
  "pushed_at" timestamp with time zone,
  "pull_request_provider" text,
  "pull_request_external_id" text,
  "pull_request_url" text,
  "review_status" text DEFAULT 'pending' NOT NULL,
  "merge_status" text DEFAULT 'pending' NOT NULL,
  "merged_at" timestamp with time zone,
  "delivery_status" text DEFAULT 'pending' NOT NULL,
  "failure_code" text,
  "failure_summary" text,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "requirement_repositories_requirement_fk" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE cascade,
  CONSTRAINT "requirement_repositories_repository_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE restrict,
  CONSTRAINT "requirement_repositories_retry_check" CHECK ("retry_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_requirement_repositories_unique" ON "requirement_repositories" ("requirement_id", "repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_repositories_requirement" ON "requirement_repositories" ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_repositories_repository" ON "requirement_repositories" ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_repositories_delivery" ON "requirement_repositories" ("delivery_status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "task_repositories_task_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade,
  CONSTRAINT "task_repositories_repository_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_repositories_unique" ON "task_repositories" ("task_id", "repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_repositories_task" ON "task_repositories" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_repositories_repository" ON "task_repositories" ("repository_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repository_checkout_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "checkout_path" text NOT NULL,
  "remote_identity" text,
  "last_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repository_checkout_bindings_repository_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_repository_checkout_bindings_unique" ON "repository_checkout_bindings" ("repository_id", "node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repository_checkout_bindings_node" ON "repository_checkout_bindings" ("node_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_entity_type_check'
  ) THEN
    ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_entity_type_check";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "activity_log"
  ADD CONSTRAINT "activity_log_entity_type_check"
  CHECK ("entity_type" IN (
    'project',
    'task',
    'document',
    'requirement',
    'repository',
    'schedule',
    'pi_agent_model_config',
    'pi_agent_policy',
    'pi_agent_run',
    'assistant_conversation',
    'assistant_message',
    'assistant_action',
    'skill_package'
  ));
--> statement-breakpoint
WITH legacy AS (
  SELECT
    p.id AS project_id,
    p.created_by,
    p.git_url,
    lower(trim(both '/' from regexp_replace(
      regexp_replace(
        regexp_replace(trim(p.git_url), '^[a-z][a-z0-9+.-]*://', '', 'i'),
        '^[^@/]+@', '', 'i'
      ),
      '\.git/?$', '', 'i'
    ))) AS stripped
  FROM projects p
  WHERE p.git_url IS NOT NULL AND btrim(p.git_url) <> ''
), normalized AS (
  SELECT
    project_id,
    created_by,
    git_url,
    regexp_replace(stripped, '^([^/:]+):', '\1/') AS canonical_key
  FROM legacy
), coordinates AS (
  SELECT
    project_id,
    created_by,
    git_url,
    canonical_key,
    split_part(canonical_key, '/', 1) AS host,
    regexp_replace(regexp_replace(canonical_key, '^[^/]+/', ''), '/[^/]+$', '') AS namespace,
    regexp_replace(canonical_key, '^.*/', '') AS name
  FROM normalized
  WHERE canonical_key LIKE '%/%'
)
INSERT INTO repositories (
  display_name, provider, host, namespace, name, canonical_key,
  https_clone_url, ssh_clone_url, visibility, created_by
)
SELECT DISTINCT ON (canonical_key)
  name,
  CASE
    WHEN host = 'github.com' THEN 'github'
    WHEN host LIKE '%gitea%' THEN 'gitea'
    WHEN host = 'gitlab.com' THEN 'gitlab'
    ELSE 'generic'
  END,
  host,
  namespace,
  name,
  canonical_key,
  CASE WHEN git_url ~* '^https://' THEN git_url ELSE NULL END,
  CASE WHEN git_url ~* '^(ssh://|[^/@]+@)' THEN git_url ELSE NULL END,
  'instance',
  created_by
FROM coordinates
WHERE host <> '' AND namespace <> '' AND name <> ''
ORDER BY canonical_key, project_id
ON CONFLICT (canonical_key) DO NOTHING;
--> statement-breakpoint
WITH legacy_projects AS (
  SELECT
    p.id AS project_id,
    lower(trim(both '/' from regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(trim(p.git_url), '^[a-z][a-z0-9+.-]*://', '', 'i'),
          '^[^@/]+@', '', 'i'
        ),
        '\.git/?$', '', 'i'
      ),
      '^([^/:]+):', '\1/'
    ))) AS canonical_key
  FROM projects p
  WHERE p.git_url IS NOT NULL AND btrim(p.git_url) <> ''
)
INSERT INTO requirement_repositories (
  requirement_id, repository_id, working_branch, delivery_status
)
SELECT r.id, repo.id, r.branch_name, 'pending'
FROM requirements r
JOIN legacy_projects lp ON lp.project_id = r.project_id
JOIN repositories repo ON repo.canonical_key = lp.canonical_key
ON CONFLICT (requirement_id, repository_id) DO UPDATE
SET working_branch = COALESCE(requirement_repositories.working_branch, EXCLUDED.working_branch);
--> statement-breakpoint
COMMENT ON COLUMN "projects"."git_url" IS 'Deprecated compatibility column. Repository links are the source of truth; remove after daemon rollout.';
