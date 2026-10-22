CREATE TABLE "task_weaver"."inbound_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "name" text NOT NULL,
  "project_id" uuid NOT NULL, "requirement_id" uuid NOT NULL, "owner_actor_id" uuid NOT NULL,
  "credential_id" uuid NOT NULL, "credential_kind" text NOT NULL, "authority_ceiling" jsonb NOT NULL,
  "binding_id" uuid DEFAULT gen_random_uuid() NOT NULL, "secret" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL, "rules" jsonb NOT NULL, "deleted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "inbound_sources_project" ON "task_weaver"."inbound_sources" ("project_id");
--> statement-breakpoint
CREATE TABLE "task_weaver"."inbound_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "task_weaver"."inbound_sources"("id"),
  "binding_id" uuid NOT NULL, "external_id" text NOT NULL, "event_type" text NOT NULL,
  "payload_hash" text NOT NULL, "payload" jsonb NOT NULL, "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamptz,
  "lease_id" uuid, "lease_expires_at" timestamptz, "error_code" text,
  "received_at" timestamptz DEFAULT now() NOT NULL, "processed_at" timestamptz
);
CREATE UNIQUE INDEX "inbound_event_identity" ON "task_weaver"."inbound_events" ("source_id", "binding_id", "external_id");
CREATE INDEX "inbound_events_pending" ON "task_weaver"."inbound_events" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE "task_weaver"."inbound_action_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "task_weaver"."inbound_events"("id"),
  "rule_id" uuid NOT NULL, "action_index" integer NOT NULL, "action_type" text NOT NULL,
  "entity_id" uuid, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "inbound_action_identity" ON "task_weaver"."inbound_action_receipts" ("event_id", "rule_id", "action_index");
