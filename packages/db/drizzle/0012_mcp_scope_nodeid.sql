ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "node_id" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "scope" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mcp_servers_scope_check'
      AND conrelid = 'mcp_servers'::regclass
  ) THEN
    ALTER TABLE "mcp_servers"
      ADD CONSTRAINT "mcp_servers_scope_check"
      CHECK ("scope" IS NULL OR "scope" IN ('private', 'local'));
  END IF;
END $$;
--> statement-breakpoint
UPDATE "mcp_servers"
SET "scope" = 'private'
WHERE "transport" = 'stdio'
  AND "scope" IS NULL;
