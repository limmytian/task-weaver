ALTER TABLE "task_weaver"."memories" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_weaver"."memories" ADD COLUMN "provenance" jsonb;
--> statement-breakpoint
CREATE TABLE "task_weaver"."memory_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "scope_key" text NOT NULL,
  "key" uuid NOT NULL,
  "payload_hash" text NOT NULL,
  "memory_id" uuid REFERENCES "task_weaver"."memories"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_receipts_identity" ON "task_weaver"."memory_receipts" ("actor_id", "actor_type", "scope_key", "key");
