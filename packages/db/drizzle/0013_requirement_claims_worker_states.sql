CREATE TABLE IF NOT EXISTS "requirement_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL,
  "claimed_by" text NOT NULL,
  "claimed_by_type" "task_weaver"."actor_type" NOT NULL,
  "daemon_id" uuid,
  "worker_index" text,
  "expires_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requirement_claims_requirement_id_requirements_id_fk'
      AND conrelid = 'requirement_claims'::regclass
  ) THEN
    ALTER TABLE "requirement_claims"
      ADD CONSTRAINT "requirement_claims_requirement_id_requirements_id_fk"
      FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_requirement_claims_requirement_unique" ON "requirement_claims" USING btree ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_claims_claimed_by" ON "requirement_claims" USING btree ("claimed_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_claims_expires" ON "requirement_claims" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_requirement_claims_daemon" ON "requirement_claims" USING btree ("daemon_id");
--> statement-breakpoint
ALTER TABLE "task_weaver"."daemons"
  ADD COLUMN IF NOT EXISTS "active_worker_states" jsonb NOT NULL DEFAULT '[]'::jsonb;
