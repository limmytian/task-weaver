ALTER TABLE "requirements"
  ADD COLUMN IF NOT EXISTS "lease_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "requirement_claims"
  ADD COLUMN IF NOT EXISTS "generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "requirements" r
SET "lease_generation" = GREATEST(r."lease_generation", rc."generation")
FROM "requirement_claims" rc
WHERE rc."requirement_id" = r."id";
