CREATE TABLE "mcp_plan_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "credential_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "idempotency_key" uuid NOT NULL,
  "plan_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_plan_receipts_credential_project_key" ON "mcp_plan_receipts" ("credential_id", "project_id", "idempotency_key");
