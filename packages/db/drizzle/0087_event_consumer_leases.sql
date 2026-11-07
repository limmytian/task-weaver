ALTER TABLE "task_weaver"."event_consumers" ADD COLUMN "lease_owner" uuid;
ALTER TABLE "task_weaver"."event_consumers" ADD COLUMN "lease_generation" bigint NOT NULL DEFAULT 0;
ALTER TABLE "task_weaver"."event_consumers" ADD COLUMN "lease_expires_at" timestamp with time zone;
ALTER TABLE "task_weaver"."event_consumers" ADD CONSTRAINT "event_consumer_lease_valid" CHECK ("lease_generation" >= 0 AND (("lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "lease_generation" > 0)));
