ALTER TABLE documents ADD COLUMN form text NOT NULL DEFAULT 'markdown', ADD COLUMN current_file_version_id uuid;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT document_form_check CHECK (form IN ('markdown', 'attachment'));
--> statement-breakpoint
ALTER TABLE document_versions ADD COLUMN file_version_id uuid;
--> statement-breakpoint
CREATE TABLE document_file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version integer NOT NULL, original_filename text NOT NULL, mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0), sha256 text NOT NULL, storage_backend text NOT NULL, object_key text NOT NULL,
  created_by text NOT NULL, created_by_type actor_type NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_document_file_version ON document_file_versions(document_id, version);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_document_file_object ON document_file_versions(object_key);
--> statement-breakpoint
CREATE TABLE document_file_garbage (object_key text PRIMARY KEY, storage_backend text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT attachment_content_check CHECK (form <> 'attachment' OR content = '');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION documents_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    CASE WHEN NEW.form = 'attachment' THEN
      setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
      setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B')
    ELSE setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B') END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'documents'::regclass AND attname = 'search_vector' AND NOT attisdropped) THEN
    DROP TRIGGER IF EXISTS trig_documents_search_vector ON documents;
    CREATE TRIGGER trig_documents_search_vector BEFORE INSERT OR UPDATE OF title, content, summary, tags, form ON documents FOR EACH ROW EXECUTE FUNCTION documents_search_vector_update();
  END IF;
END $$;
