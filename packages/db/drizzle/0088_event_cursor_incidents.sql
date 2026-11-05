CREATE TABLE "task_weaver"."event_cursor_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL, "principal_id" text NOT NULL, "consumer" text NOT NULL,
  "cursor" bigint NOT NULL, "retention_floor" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(), "resolved_at" timestamptz,
  CONSTRAINT "event_cursor_incident_valid" CHECK ("cursor" >= 0 AND "retention_floor" > "cursor" AND length("consumer") > 0 AND length("principal_id") > 0 AND "principal_type" IN ('human', 'agent'))
);
CREATE UNIQUE INDEX "event_cursor_incidents_open_unique" ON "task_weaver"."event_cursor_incidents" ("project_id", "principal_type", "principal_id", "consumer") WHERE "resolved_at" IS NULL;
