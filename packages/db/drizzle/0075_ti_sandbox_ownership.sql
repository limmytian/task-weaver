CREATE TABLE "task_weaver"."ti_sandbox_workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" text NOT NULL,
  "owner_type" "task_weaver"."actor_type" NOT NULL,
  "project_id" uuid,
  "conversation_id" uuid,
  "run_id" uuid,
  "attempt" integer NOT NULL,
  "binding_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "provider_project_id" text NOT NULL,
  "session_request_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text,
  "state" text DEFAULT 'provisioning' NOT NULL,
  "cancel_requested_at" timestamptz,
  "cleanup_requested_at" timestamptz,
  "cleanup_attempts" integer DEFAULT 0 NOT NULL,
  "next_cleanup_at" timestamptz,
  "cleanup_lease_id" uuid,
  "cleanup_lease_expires_at" timestamptz,
  "last_error_code" text,
  "expires_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ti_sandbox_context" CHECK (("conversation_id" IS NOT NULL)::int + ("run_id" IS NOT NULL)::int = 1 AND "attempt" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ti_sandbox_conversation_attempt" ON "task_weaver"."ti_sandbox_workspaces" ("owner_id", "owner_type", "conversation_id", "attempt");
CREATE UNIQUE INDEX "ti_sandbox_run_attempt" ON "task_weaver"."ti_sandbox_workspaces" ("run_id", "attempt");
CREATE UNIQUE INDEX "ti_sandbox_provider_session" ON "task_weaver"."ti_sandbox_workspaces" ("binding_id", "session_id");
CREATE INDEX "ti_sandbox_cleanup_due" ON "task_weaver"."ti_sandbox_workspaces" ("state", "next_cleanup_at");
CREATE INDEX "ti_sandbox_owner" ON "task_weaver"."ti_sandbox_workspaces" ("owner_id", "owner_type", "state");
--> statement-breakpoint
CREATE TABLE "task_weaver"."ti_sandbox_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "task_weaver"."ti_sandbox_workspaces"("id"),
  "logical_key" text NOT NULL,
  "request_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tool" text NOT NULL,
  "arguments" jsonb NOT NULL,
  "argument_hash" text NOT NULL,
  "job_id" text,
  "state" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "last_error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ti_sandbox_operation_key" ON "task_weaver"."ti_sandbox_operations" ("workspace_id", "logical_key");
CREATE UNIQUE INDEX "ti_sandbox_operation_request" ON "task_weaver"."ti_sandbox_operations" ("request_id");
CREATE UNIQUE INDEX "ti_sandbox_operation_job" ON "task_weaver"."ti_sandbox_operations" ("workspace_id", "job_id");
