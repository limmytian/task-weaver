ALTER TABLE "task_weaver"."webhook_deliveries" ADD COLUMN "event_id" uuid;
ALTER TABLE "task_weaver"."webhook_deliveries" ADD COLUMN "replay_of" uuid;
ALTER TABLE "task_weaver"."webhook_deliveries" ADD COLUMN "lease_id" uuid;
ALTER TABLE "task_weaver"."webhook_deliveries" ADD COLUMN "lease_expires_at" timestamptz;
ALTER TABLE "task_weaver"."webhook_deliveries" ADD COLUMN "delivered_at" timestamptz;
CREATE UNIQUE INDEX "webhook_delivery_logical_event" ON "task_weaver"."webhook_deliveries" ("webhook_id", "binding_id", "event_id") WHERE "replay_of" IS NULL;
--> statement-breakpoint
CREATE TABLE "task_weaver"."webhook_events" (
  "id" uuid PRIMARY KEY NOT NULL, "version" integer DEFAULT 1 NOT NULL, "event_type" text NOT NULL,
  "project_id" uuid, "actor_id" text, "actor_type" text, "causation_id" uuid, "correlation_id" uuid NOT NULL,
  "event" jsonb NOT NULL, "occurred_at" timestamptz NOT NULL, "expanded_at" timestamptz
);
CREATE INDEX "webhook_events_pending" ON "task_weaver"."webhook_events" ("expanded_at", "occurred_at");
--> statement-breakpoint
CREATE TABLE "task_weaver"."webhook_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "task_weaver"."webhook_deliveries"("id") ON DELETE CASCADE,
  "attempt" integer NOT NULL, "outcome" text NOT NULL, "http_status" integer, "error_code" text,
  "started_at" timestamptz DEFAULT now() NOT NULL, "ended_at" timestamptz
);
CREATE UNIQUE INDEX "webhook_attempt_identity" ON "task_weaver"."webhook_delivery_attempts" ("delivery_id", "attempt");
