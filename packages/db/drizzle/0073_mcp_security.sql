CREATE TABLE "mcp_invocation_audits" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "actor_id" uuid NOT NULL, "credential_id" uuid NOT NULL,
 "scope_key" text NOT NULL, "server_id" text NOT NULL, "tool_id" text NOT NULL,
 "outcome" text NOT NULL, "error_code" text, "duration_ms" integer NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "mcp_invocation_audits_scope_time" ON "mcp_invocation_audits" ("scope_key", "created_at");
CREATE TABLE "mcp_invocation_policies" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "scope_key" text NOT NULL, "tool_id" text NOT NULL,
 "mode" text NOT NULL CHECK ("mode" IN ('allow','approval','deny')), "version" integer NOT NULL DEFAULT 1, "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "mcp_invocation_policies_scope_tool" ON "mcp_invocation_policies" ("scope_key", "tool_id");
CREATE TABLE "mcp_invocation_approvals" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "actor_id" uuid NOT NULL, "credential_id" uuid NOT NULL,
 "scope_key" text NOT NULL, "tool_id" text NOT NULL, "operation_hash" text NOT NULL, "authority_hash" text NOT NULL,
 "policy_versions" jsonb NOT NULL, "approved_by" uuid, "approved_credential_id" uuid, "approved_credential_kind" text, "used_at" timestamptz, "expires_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "mcp_invocation_approvals_expiry" ON "mcp_invocation_approvals" ("expires_at");
ALTER TABLE "mcp_servers" ADD COLUMN "read_only" boolean NOT NULL DEFAULT false;
ALTER TABLE "mcp_tools" ADD COLUMN "read_only" boolean NOT NULL DEFAULT false;
ALTER TABLE "mcp_tools" ADD COLUMN "target_project_argument" text;
