-- A typmod-free vector column is required because immutable generations may use
-- different dimensions. pgvector cannot build one HNSW index over such a column,
-- so each generation owns a partial expression index with its fixed dimension.
DROP INDEX IF EXISTS "task_weaver"."idx_document_embeddings_hnsw_cosine";

CREATE OR REPLACE FUNCTION "task_weaver"."embedding_generation_hnsw_index_name"("target_generation_id" uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT 'idx_de_hnsw_' || replace("target_generation_id"::text, '-', '');
$$;

CREATE OR REPLACE FUNCTION "task_weaver"."ensure_embedding_generation_hnsw_index"("target_generation_id" uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  generation_dimensions integer;
  generation_index_name text;
  vector_schema_name text;
BEGIN
  SELECT "dimensions"
    INTO generation_dimensions
  FROM "task_weaver"."embedding_generations"
  WHERE "id" = "target_generation_id";

  IF generation_dimensions IS NULL THEN
    RAISE EXCEPTION 'embedding generation does not exist';
  END IF;
  IF generation_dimensions NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'embedding generation dimensions are outside the pgvector HNSW range';
  END IF;

  SELECT namespace."nspname"
    INTO vector_schema_name
  FROM pg_catalog.pg_extension extension
  JOIN pg_catalog.pg_namespace namespace ON namespace."oid" = extension."extnamespace"
  WHERE extension."extname" = 'vector';
  IF vector_schema_name IS NULL THEN
    RAISE EXCEPTION 'pgvector extension is not installed';
  END IF;

  generation_index_name := "task_weaver"."embedding_generation_hnsw_index_name"("target_generation_id");
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON "task_weaver"."document_embeddings" USING hnsw (("embedding"::%I.%I(%s)) %I.%I) WHERE "generation_id" = %L::uuid',
    generation_index_name,
    vector_schema_name,
    'vector',
    generation_dimensions,
    vector_schema_name,
    'vector_cosine_ops',
    "target_generation_id"
  );
  RETURN generation_index_name;
END;
$$;

CREATE OR REPLACE FUNCTION "task_weaver"."drop_embedding_generation_hnsw_index"("target_generation_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format(
    'DROP INDEX IF EXISTS %I.%I',
    'task_weaver',
    "task_weaver"."embedding_generation_hnsw_index_name"("target_generation_id")
  );
END;
$$;

CREATE OR REPLACE FUNCTION "task_weaver"."ensure_embedding_generation_hnsw_index_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "task_weaver"."ensure_embedding_generation_hnsw_index"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "task_weaver"."drop_embedding_generation_hnsw_index_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "task_weaver"."drop_embedding_generation_hnsw_index"(OLD."id");
  RETURN OLD;
END;
$$;

-- Repair environments where the embedding foundation migration was applied
-- before generation-scoped indexes were introduced.
DO $$
DECLARE
  generation_record record;
BEGIN
  FOR generation_record IN
    SELECT "id" FROM "task_weaver"."embedding_generations"
  LOOP
    PERFORM "task_weaver"."ensure_embedding_generation_hnsw_index"(generation_record."id");
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS "embedding_generation_create_hnsw_index" ON "task_weaver"."embedding_generations";
CREATE TRIGGER "embedding_generation_create_hnsw_index"
AFTER INSERT ON "task_weaver"."embedding_generations"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."ensure_embedding_generation_hnsw_index_trigger"();

DROP TRIGGER IF EXISTS "embedding_generation_drop_hnsw_index" ON "task_weaver"."embedding_generations";
CREATE TRIGGER "embedding_generation_drop_hnsw_index"
BEFORE DELETE ON "task_weaver"."embedding_generations"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."drop_embedding_generation_hnsw_index_trigger"();

COMMENT ON FUNCTION "task_weaver"."ensure_embedding_generation_hnsw_index"(uuid) IS
  'Creates the fixed-dimension partial cosine HNSW index owned by one immutable embedding generation.';
