CREATE TABLE "task_weaver"."plugin_installations" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "project_id" uuid REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
 "personal_owner_id" text,
 "personal_owner_type" "task_weaver"."actor_type",
 "created_by" text NOT NULL,
 "plugin_id" text NOT NULL,
 "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
 "status" text DEFAULT 'disabled' NOT NULL CHECK ("status" IN ('active', 'disabled', 'uninstalled')),
 "manifest" jsonb NOT NULL,
 "manifest_hash" text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 CHECK (("project_id" IS NOT NULL AND "personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
 OR ("project_id" IS NULL AND (("personal_owner_id" IS NULL AND "personal_owner_type" IS NULL)
 OR ("personal_owner_id" IS NOT NULL AND "personal_owner_type" IS NOT NULL AND "personal_owner_type" = 'human'))))
);
--> statement-breakpoint
CREATE INDEX "plugin_installations_project" ON "task_weaver"."plugin_installations" ("project_id");
--> statement-breakpoint
CREATE TABLE "task_weaver"."plugin_storage" (
 "installation_id" uuid NOT NULL REFERENCES "task_weaver"."plugin_installations"("id") ON DELETE CASCADE,
 "key" text NOT NULL,
 "version" integer NOT NULL CHECK ("version" > 0),
 "value" jsonb,
 "deleted" integer DEFAULT 0 NOT NULL CHECK ("deleted" IN (0, 1)),
 PRIMARY KEY ("installation_id", "key")
);
--> statement-breakpoint
CREATE TABLE "task_weaver"."plugin_invocation_receipts" (
 "installation_id" uuid NOT NULL REFERENCES "task_weaver"."plugin_installations"("id") ON DELETE CASCADE,
 "actor_id" text NOT NULL,
 "key" uuid NOT NULL,
 "payload_hash" text NOT NULL,
 "revision" integer NOT NULL,
 "result" jsonb,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 PRIMARY KEY ("installation_id", "actor_id", "key")
);
