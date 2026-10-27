CREATE TABLE "plan_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL,
  "created_by_type" "actor_type" NOT NULL,
  "source" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "validated_revision" integer,
  "live_fingerprint" text,
  "operation_key" uuid,
  "receipt" jsonb,
  "plan" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plan_drafts_project_updated" ON "plan_drafts" ("project_id", "updated_at");

--> statement-breakpoint
CREATE UNIQUE INDEX "plan_drafts_project_operation" ON "plan_drafts" ("project_id", "operation_key");
