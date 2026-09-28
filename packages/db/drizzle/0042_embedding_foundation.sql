CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "scope" text DEFAULT 'global' NOT NULL,
  "project_id" uuid REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "personal_owner_id" text,
  "personal_owner_type" "task_weaver"."actor_type",
  "status" text DEFAULT 'disabled' NOT NULL,
  "provider" text DEFAULT 'openai_compatible' NOT NULL,
  "base_url" text NOT NULL,
  "model" text NOT NULL,
  "dimensions" integer NOT NULL,
  "secret_ref" text NOT NULL,
  "timeout_ms" integer DEFAULT 30000 NOT NULL,
  "batch_size" integer DEFAULT 64 NOT NULL,
  "max_concurrency" integer DEFAULT 2 NOT NULL,
  "chunk_size" integer DEFAULT 1200 NOT NULL,
  "chunk_overlap" integer DEFAULT 120 NOT NULL,
  "chunking_version" text DEFAULT 'text-v1' NOT NULL,
  "retention_generations" integer DEFAULT 2 NOT NULL,
  "configuration_hash" text NOT NULL,
  "active_generation_id" uuid,
  "last_validated_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_summary" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text NOT NULL,
  "created_by_type" "task_weaver"."actor_type" NOT NULL,
  "updated_by" text NOT NULL,
  "updated_by_type" "task_weaver"."actor_type" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "embedding_profiles_scope_check" CHECK (
    ("scope" = 'global' AND "project_id" IS NULL AND "personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
    OR ("scope" = 'project' AND "project_id" IS NOT NULL AND "personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
    OR ("scope" = 'personal' AND "project_id" IS NULL AND "personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
  ),
  CONSTRAINT "embedding_profiles_status_check" CHECK ("status" IN ('disabled', 'enabled', 'failed')),
  CONSTRAINT "embedding_profiles_provider_check" CHECK ("provider" = 'openai_compatible'),
  CONSTRAINT "embedding_profiles_dimensions_check" CHECK ("dimensions" BETWEEN 1 AND 2000),
  CONSTRAINT "embedding_profiles_timeout_check" CHECK ("timeout_ms" BETWEEN 100 AND 120000),
  CONSTRAINT "embedding_profiles_batch_size_check" CHECK ("batch_size" BETWEEN 1 AND 2048),
  CONSTRAINT "embedding_profiles_concurrency_check" CHECK ("max_concurrency" BETWEEN 1 AND 32),
  CONSTRAINT "embedding_profiles_chunk_size_check" CHECK ("chunk_size" BETWEEN 100 AND 32000),
  CONSTRAINT "embedding_profiles_chunk_overlap_check" CHECK ("chunk_overlap" >= 0 AND "chunk_overlap" < "chunk_size"),
  CONSTRAINT "embedding_profiles_retention_check" CHECK ("retention_generations" BETWEEN 1 AND 100),
  CONSTRAINT "embedding_profiles_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_profiles_global_name"
  ON "task_weaver"."embedding_profiles" ("name") WHERE "scope" = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_profiles_project_name"
  ON "task_weaver"."embedding_profiles" ("project_id", "name") WHERE "scope" = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_profiles_personal_name"
  ON "task_weaver"."embedding_profiles" ("personal_owner_id", "personal_owner_type", "name")
  WHERE "scope" = 'personal';
CREATE INDEX IF NOT EXISTS "idx_embedding_profiles_status"
  ON "task_weaver"."embedding_profiles" ("status");
CREATE INDEX IF NOT EXISTS "idx_embedding_profiles_active_generation"
  ON "task_weaver"."embedding_profiles" ("active_generation_id");

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_profiles"("id") ON DELETE CASCADE,
  "generation_number" integer NOT NULL,
  "status" text DEFAULT 'building' NOT NULL,
  "provider" text NOT NULL,
  "base_url" text NOT NULL,
  "model" text NOT NULL,
  "dimensions" integer NOT NULL,
  "chunk_size" integer NOT NULL,
  "chunk_overlap" integer NOT NULL,
  "chunking_version" text NOT NULL,
  "configuration_hash" text NOT NULL,
  "total_documents" integer DEFAULT 0 NOT NULL,
  "covered_documents" integer DEFAULT 0 NOT NULL,
  "total_chunks" integer DEFAULT 0 NOT NULL,
  "embedded_chunks" integer DEFAULT 0 NOT NULL,
  "failed_chunks" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_summary" text,
  "created_by" text NOT NULL,
  "created_by_type" "task_weaver"."actor_type" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "build_completed_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  CONSTRAINT "embedding_generations_number_check" CHECK ("generation_number" > 0),
  CONSTRAINT "embedding_generations_status_check" CHECK ("status" IN ('building', 'active', 'failed', 'retired')),
  CONSTRAINT "embedding_generations_provider_check" CHECK ("provider" = 'openai_compatible'),
  CONSTRAINT "embedding_generations_dimensions_check" CHECK ("dimensions" BETWEEN 1 AND 2000),
  CONSTRAINT "embedding_generations_chunk_size_check" CHECK ("chunk_size" BETWEEN 100 AND 32000),
  CONSTRAINT "embedding_generations_chunk_overlap_check" CHECK ("chunk_overlap" >= 0 AND "chunk_overlap" < "chunk_size"),
  CONSTRAINT "embedding_generations_coverage_check" CHECK (
    "total_documents" >= 0 AND "covered_documents" >= 0 AND "covered_documents" <= "total_documents"
    AND "total_chunks" >= 0 AND "embedded_chunks" >= 0 AND "failed_chunks" >= 0
    AND "embedded_chunks" + "failed_chunks" <= "total_chunks"
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_generations_profile_number"
  ON "task_weaver"."embedding_generations" ("profile_id", "generation_number");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_generations_profile_config"
  ON "task_weaver"."embedding_generations" ("profile_id", "configuration_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_generations_profile_id_pair"
  ON "task_weaver"."embedding_generations" ("profile_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_generations_one_active"
  ON "task_weaver"."embedding_generations" ("profile_id") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_embedding_generations_status"
  ON "task_weaver"."embedding_generations" ("status");

ALTER TABLE "task_weaver"."embedding_profiles"
  ADD CONSTRAINT "embedding_profiles_active_generation_fk"
  FOREIGN KEY ("id", "active_generation_id")
  REFERENCES "task_weaver"."embedding_generations"("profile_id", "id")
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_document_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "generation_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_generations"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "task_weaver"."documents"("id") ON DELETE CASCADE,
  "document_version" integer NOT NULL,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "token_count" integer,
  "character_start" integer NOT NULL,
  "character_end" integer NOT NULL,
  "scope" text NOT NULL,
  "project_id" uuid REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "personal_owner_id" text,
  "personal_owner_type" "task_weaver"."actor_type",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "embedding_chunks_version_index_check" CHECK ("document_version" > 0 AND "chunk_index" >= 0),
  CONSTRAINT "embedding_chunks_character_range_check" CHECK (
    "character_start" >= 0 AND "character_end" > "character_start"
  ),
  CONSTRAINT "embedding_chunks_token_count_check" CHECK ("token_count" IS NULL OR "token_count" >= 0),
  CONSTRAINT "embedding_chunks_scope_check" CHECK (
    ("scope" = 'global' AND "project_id" IS NULL AND "personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
    OR ("scope" = 'project' AND "project_id" IS NOT NULL AND "personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
    OR ("scope" = 'personal' AND "project_id" IS NULL AND "personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_chunks_generation_document_index"
  ON "task_weaver"."embedding_document_chunks" ("generation_id", "document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "idx_embedding_chunks_document"
  ON "task_weaver"."embedding_document_chunks" ("document_id");
CREATE INDEX IF NOT EXISTS "idx_embedding_chunks_scope"
  ON "task_weaver"."embedding_document_chunks"
  ("generation_id", "scope", "project_id", "personal_owner_id", "personal_owner_type");
CREATE INDEX IF NOT EXISTS "idx_embedding_chunks_content_hash"
  ON "task_weaver"."embedding_document_chunks" ("generation_id", "content_hash");

CREATE TABLE IF NOT EXISTS "task_weaver"."document_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "generation_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_generations"("id") ON DELETE CASCADE,
  "chunk_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_document_chunks"("id") ON DELETE CASCADE,
  "embedding" vector NOT NULL,
  "dimensions" integer NOT NULL,
  "content_hash" text NOT NULL,
  "provider_request_id" text,
  "usage_tokens" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_embeddings_dimensions_check" CHECK ("dimensions" BETWEEN 1 AND 2000),
  CONSTRAINT "document_embeddings_usage_check" CHECK ("usage_tokens" IS NULL OR "usage_tokens" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_document_embeddings_generation_chunk"
  ON "task_weaver"."document_embeddings" ("generation_id", "chunk_id");
CREATE INDEX IF NOT EXISTS "idx_document_embeddings_generation"
  ON "task_weaver"."document_embeddings" ("generation_id");

CREATE TABLE IF NOT EXISTS "task_weaver"."document_embedding_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_profiles"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "task_weaver"."documents"("id") ON DELETE CASCADE,
  "generation_id" uuid REFERENCES "task_weaver"."embedding_generations"("id") ON DELETE SET NULL,
  "state" text DEFAULT 'missing' NOT NULL,
  "document_version" integer NOT NULL,
  "content_hash" text NOT NULL,
  "total_chunks" integer DEFAULT 0 NOT NULL,
  "embedded_chunks" integer DEFAULT 0 NOT NULL,
  "failed_chunks" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error_summary" text,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reconciled_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_embedding_states_state_check" CHECK ("state" IN ('missing', 'stale', 'indexing', 'complete', 'failed')),
  CONSTRAINT "document_embedding_states_version_check" CHECK ("document_version" > 0),
  CONSTRAINT "document_embedding_states_coverage_check" CHECK (
    "total_chunks" >= 0 AND "embedded_chunks" >= 0 AND "failed_chunks" >= 0
    AND "embedded_chunks" + "failed_chunks" <= "total_chunks"
  ),
  CONSTRAINT "document_embedding_states_generation_profile_fk"
    FOREIGN KEY ("profile_id", "generation_id")
    REFERENCES "task_weaver"."embedding_generations"("profile_id", "id")
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_document_embedding_states_profile_document"
  ON "task_weaver"."document_embedding_states" ("profile_id", "document_id");
CREATE INDEX IF NOT EXISTS "idx_document_embedding_states_profile_state"
  ON "task_weaver"."document_embedding_states" ("profile_id", "state");
CREATE INDEX IF NOT EXISTS "idx_document_embedding_states_generation"
  ON "task_weaver"."document_embedding_states" ("generation_id");

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_profiles"("id") ON DELETE CASCADE,
  "generation_id" uuid REFERENCES "task_weaver"."embedding_generations"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "configuration_hash" text NOT NULL,
  "requested_by" text NOT NULL,
  "requested_by_type" "task_weaver"."actor_type" NOT NULL,
  "request_reason" text,
  "total_items" integer DEFAULT 0 NOT NULL,
  "pending_items" integer DEFAULT 0 NOT NULL,
  "completed_items" integer DEFAULT 0 NOT NULL,
  "failed_items" integer DEFAULT 0 NOT NULL,
  "skipped_items" integer DEFAULT 0 NOT NULL,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "max_retries" integer DEFAULT 5 NOT NULL,
  "cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "cancel_requested_at" timestamp with time zone,
  "error_code" text,
  "error_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "embedding_jobs_kind_check" CHECK ("kind" IN ('incremental', 'full', 'forced')),
  CONSTRAINT "embedding_jobs_status_check" CHECK (
    "status" IN ('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed')
  ),
  CONSTRAINT "embedding_jobs_progress_check" CHECK (
    "total_items" >= 0 AND "pending_items" >= 0 AND "completed_items" >= 0
    AND "failed_items" >= 0 AND "skipped_items" >= 0 AND "prompt_tokens" >= 0
    AND "retry_count" >= 0 AND "max_retries" >= 0
  ),
  CONSTRAINT "embedding_jobs_generation_profile_fk"
    FOREIGN KEY ("profile_id", "generation_id")
    REFERENCES "task_weaver"."embedding_generations"("profile_id", "id")
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS "idx_embedding_jobs_profile_status"
  ON "task_weaver"."embedding_jobs" ("profile_id", "status");
CREATE INDEX IF NOT EXISTS "idx_embedding_jobs_generation"
  ON "task_weaver"."embedding_jobs" ("generation_id");
CREATE INDEX IF NOT EXISTS "idx_embedding_jobs_lease"
  ON "task_weaver"."embedding_jobs" ("lease_expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_jobs_one_active_generation"
  ON "task_weaver"."embedding_jobs" ("generation_id")
  WHERE "generation_id" IS NOT NULL
    AND "status" IN ('queued', 'running', 'pausing', 'paused', 'cancelling');

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_job_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_jobs"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL,
  "action" text DEFAULT 'upsert' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "document_version" integer,
  "content_hash" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "error_code" text,
  "error_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "embedding_job_items_action_check" CHECK ("action" IN ('upsert', 'delete')),
  CONSTRAINT "embedding_job_items_status_check" CHECK (
    "status" IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')
  ),
  CONSTRAINT "embedding_job_items_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "embedding_job_items_version_check" CHECK ("document_version" IS NULL OR "document_version" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_embedding_job_items_job_document_action"
  ON "task_weaver"."embedding_job_items" ("job_id", "document_id", "action");
CREATE INDEX IF NOT EXISTS "idx_embedding_job_items_claimable"
  ON "task_weaver"."embedding_job_items" ("job_id", "status", "next_attempt_at", "lease_expires_at");

CREATE TABLE IF NOT EXISTS "task_weaver"."embedding_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "task_weaver"."embedding_profiles"("id") ON DELETE CASCADE,
  "generation_id" uuid REFERENCES "task_weaver"."embedding_generations"("id") ON DELETE SET NULL,
  "job_id" uuid REFERENCES "task_weaver"."embedding_jobs"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "actor_type" "task_weaver"."actor_type" NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_embedding_lifecycle_events_profile_time"
  ON "task_weaver"."embedding_lifecycle_events" ("profile_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_embedding_lifecycle_events_generation"
  ON "task_weaver"."embedding_lifecycle_events" ("generation_id");
CREATE INDEX IF NOT EXISTS "idx_embedding_lifecycle_events_job"
  ON "task_weaver"."embedding_lifecycle_events" ("job_id");

CREATE OR REPLACE FUNCTION "task_weaver"."enforce_embedding_generation_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.profile_id,
    OLD.generation_number,
    OLD.provider,
    OLD.base_url,
    OLD.model,
    OLD.dimensions,
    OLD.chunk_size,
    OLD.chunk_overlap,
    OLD.chunking_version,
    OLD.configuration_hash
  ) IS DISTINCT FROM ROW(
    NEW.profile_id,
    NEW.generation_number,
    NEW.provider,
    NEW.base_url,
    NEW.model,
    NEW.dimensions,
    NEW.chunk_size,
    NEW.chunk_overlap,
    NEW.chunking_version,
    NEW.configuration_hash
  ) THEN
    RAISE EXCEPTION 'embedding generation configuration is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "embedding_generation_immutable_config" ON "task_weaver"."embedding_generations";
CREATE TRIGGER "embedding_generation_immutable_config"
BEFORE UPDATE ON "task_weaver"."embedding_generations"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."enforce_embedding_generation_immutability"();

CREATE OR REPLACE FUNCTION "task_weaver"."validate_document_embedding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_dimensions integer;
  chunk_generation_id uuid;
  chunk_content_hash text;
BEGIN
  SELECT "dimensions" INTO expected_dimensions
  FROM "task_weaver"."embedding_generations"
  WHERE "id" = NEW.generation_id;

  SELECT "generation_id", "content_hash" INTO chunk_generation_id, chunk_content_hash
  FROM "task_weaver"."embedding_document_chunks"
  WHERE "id" = NEW.chunk_id;

  IF expected_dimensions IS NULL OR chunk_generation_id IS NULL THEN
    RAISE EXCEPTION 'embedding generation and chunk must exist';
  END IF;
  IF chunk_generation_id <> NEW.generation_id THEN
    RAISE EXCEPTION 'embedding chunk belongs to a different generation';
  END IF;
  IF chunk_content_hash <> NEW.content_hash THEN
    RAISE EXCEPTION 'embedding content hash does not match its chunk';
  END IF;
  IF NEW.dimensions <> expected_dimensions OR vector_dims(NEW.embedding) <> expected_dimensions THEN
    RAISE EXCEPTION 'embedding dimensions do not match generation dimensions';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "document_embedding_validate" ON "task_weaver"."document_embeddings";
CREATE TRIGGER "document_embedding_validate"
BEFORE INSERT OR UPDATE ON "task_weaver"."document_embeddings"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."validate_document_embedding"();

COMMENT ON TABLE "task_weaver"."embedding_profiles" IS
  'Opt-in embedding configuration. Existing full-text search remains authoritative until a profile is enabled and has an active generation.';
COMMENT ON COLUMN "task_weaver"."embedding_profiles"."secret_ref" IS
  'Opaque credential reference only. Raw provider credentials must never be stored here.';
COMMENT ON TABLE "task_weaver"."embedding_generations" IS
  'Immutable model and chunking snapshots. Only lifecycle and progress fields may change.';
