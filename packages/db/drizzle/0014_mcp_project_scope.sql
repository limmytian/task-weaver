ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mcp_servers_project_id_projects_id_fk'
      AND conrelid = 'mcp_servers'::regclass
  ) THEN
    ALTER TABLE "mcp_servers"
      ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_servers_project" ON "mcp_servers" USING btree ("project_id");
