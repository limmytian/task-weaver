ALTER TABLE "mcp_servers" ADD COLUMN "registered_by" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "registered_credential_id" text;
--> statement-breakpoint
CREATE TABLE "mcp_local_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "tool_id" uuid REFERENCES "mcp_tools"("id") ON DELETE SET NULL,
  "tool_name" text NOT NULL,
  "caller_context" jsonb NOT NULL,
  "called_by" text NOT NULL,
  "called_by_type" "actor_type" NOT NULL,
  "arguments" jsonb,
  "result" jsonb,
  "status" text DEFAULT 'queued' NOT NULL,
  "lease_hash" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_mcp_local_requests_server" ON "mcp_local_requests" ("server_id", "status");

--> statement-breakpoint
DROP INDEX "idx_mcp_servers_name";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_servers_scope_name" ON "mcp_servers" ("name", coalesce("project_id"::text, ''), coalesce("personal_owner_id", ''));
