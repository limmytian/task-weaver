import { sql, type SQL } from "drizzle-orm";
import { type Database, documents } from "@task-weaver/db";

/** Fresh databases can search before the optional indexed search setup is installed. */
export async function documentSearchVector(db: Database): Promise<SQL> {
  const rows = await db.execute<{ available: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'documents'::regclass AND attname = 'search_vector' AND NOT attisdropped
    ) AS available
  `);
  const markdownVector = rows[0]?.available ? sql`search_vector` : sql`(
    setweight(to_tsvector('english', coalesce(${documents.title}, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${documents.content}, '')), 'B')
  )`;
  if (rows[0]?.available) return sql`search_vector`;
  return sql`CASE WHEN ${documents.form} = 'attachment' THEN (
    setweight(to_tsvector('english', coalesce(${documents.title}, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${documents.summary}, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(${documents.tags}, ' '), '')), 'B')
  ) ELSE ${markdownVector} END`;
}
