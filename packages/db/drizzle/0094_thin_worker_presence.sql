CREATE TABLE "task_weaver"."thin_workers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_thin_workers_project_heartbeat" ON "task_weaver"."thin_workers" ("project_id", "heartbeat_at");
