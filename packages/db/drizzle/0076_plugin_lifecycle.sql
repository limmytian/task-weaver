ALTER TABLE "task_weaver"."plugin_installations" ADD COLUMN "scope_key" text;
--> statement-breakpoint
UPDATE "task_weaver"."plugin_installations" SET "scope_key" = CASE WHEN "project_id" IS NOT NULL THEN 'project:' || "project_id"::text WHEN "personal_owner_id" IS NOT NULL THEN 'personal:' || "personal_owner_id" ELSE 'global' END;
--> statement-breakpoint
ALTER TABLE "task_weaver"."plugin_installations" ALTER COLUMN "scope_key" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_installations_live_identity" ON "task_weaver"."plugin_installations" ("scope_key", "plugin_id") WHERE "status" <> 'uninstalled';
--> statement-breakpoint
CREATE TABLE "task_weaver"."plugin_generations" (
 "installation_id" uuid NOT NULL REFERENCES "task_weaver"."plugin_installations"("id") ON DELETE CASCADE,
 "version" text NOT NULL, "manifest" jsonb NOT NULL, "manifest_hash" text NOT NULL,
 "trust" text NOT NULL CHECK ("trust" IN ('verified', 'unverified')),
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 PRIMARY KEY ("installation_id", "version")
);
--> statement-breakpoint
CREATE TABLE "task_weaver"."plugin_lifecycle_receipts" (
 "actor_id" text NOT NULL, "scope_key" text NOT NULL, "key" uuid NOT NULL,
 "installation_id" uuid NOT NULL REFERENCES "task_weaver"."plugin_installations"("id") ON DELETE CASCADE,
 "payload_hash" text NOT NULL, "revision" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 PRIMARY KEY ("actor_id", "scope_key", "key")
);
--> statement-breakpoint
ALTER TABLE "task_weaver"."plugin_installations" ADD CONSTRAINT "plugin_installations_scope_key_check" CHECK (
 "scope_key" = CASE WHEN "project_id" IS NOT NULL THEN 'project:' || "project_id"::text WHEN "personal_owner_id" IS NOT NULL THEN 'personal:' || "personal_owner_id" ELSE 'global' END
);
