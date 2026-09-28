-- Full-text search setup for documents table
-- Run this after drizzle-kit push to add tsvector column, trigger, and GIN index

-- Add tsvector column if it doesn't exist
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create or replace the trigger function
CREATE OR REPLACE FUNCTION documents_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any, then create
DROP TRIGGER IF EXISTS trig_documents_search_vector ON documents;
CREATE TRIGGER trig_documents_search_vector
  BEFORE INSERT OR UPDATE OF title, content ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_search_vector_update();

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_documents_search_vector
  ON documents USING GIN (search_vector);

-- Backfill existing rows
UPDATE documents SET search_vector =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(content, '')), 'B')
WHERE search_vector IS NULL;
