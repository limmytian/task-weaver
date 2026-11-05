CREATE TABLE "task_weaver"."event_streams" (
  "project_id" uuid PRIMARY KEY REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "next_sequence" bigint NOT NULL DEFAULT 1,
  "retention_floor" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "event_stream_bounds" CHECK ("retention_floor" >= 0 AND "next_sequence" > "retention_floor")
);
--> statement-breakpoint
CREATE TABLE "task_weaver"."durable_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."event_streams"("project_id") ON DELETE CASCADE,
  "sequence" bigint NOT NULL, "type" text NOT NULL, "version" integer NOT NULL,
  "scope" jsonb NOT NULL, "payload" jsonb NOT NULL,
  "occurred_at" timestamptz NOT NULL, "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_event_valid" CHECK ("sequence" > 0 AND "version" > 0 AND length("type") > 0 AND jsonb_typeof("scope") = 'object' AND jsonb_typeof("payload") = 'object')
);
CREATE UNIQUE INDEX "durable_events_project_sequence" ON "task_weaver"."durable_events" ("project_id", "sequence");
--> statement-breakpoint
CREATE TABLE "task_weaver"."event_consumers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."event_streams"("project_id") ON DELETE CASCADE,
  "name" text NOT NULL, "acknowledged_sequence" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "event_consumer_valid" CHECK ("acknowledged_sequence" >= 0 AND length("name") > 0)
);
CREATE UNIQUE INDEX "event_consumers_project_name" ON "task_weaver"."event_consumers" ("project_id", "name");
CREATE INDEX "event_consumers_project" ON "task_weaver"."event_consumers" ("project_id");
