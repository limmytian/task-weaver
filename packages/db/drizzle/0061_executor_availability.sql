CREATE TABLE "executor_availability" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "daemon_id" uuid NOT NULL REFERENCES "daemons"("id") ON DELETE CASCADE,
 "actor_id" text NOT NULL,
 "tool" text NOT NULL,
 "profile_id" text NOT NULL,
 "pool_id" text,
 "observation" jsonb NOT NULL,
 "observed_at" timestamptz NOT NULL,
 "next_check_at" timestamptz,
 "refresh_requested_at" timestamptz,
 "block_count" integer NOT NULL DEFAULT 0,
 "version" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "executor_availability_daemon_tool" ON "executor_availability" ("daemon_id", "tool");
CREATE INDEX "executor_availability_pool" ON "executor_availability" ("actor_id", "pool_id");
--> statement-breakpoint
CREATE TABLE "executor_availability_events" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "daemon_id" uuid NOT NULL REFERENCES "daemons"("id") ON DELETE CASCADE,
 "tool" text NOT NULL,
 "profile_id" text NOT NULL,
 "event_id" uuid NOT NULL,
 "state" text NOT NULL,
 "reason" text NOT NULL,
 "observed_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "executor_availability_event_id" ON "executor_availability_events" ("daemon_id", "event_id");
CREATE INDEX "executor_availability_event_time" ON "executor_availability_events" ("daemon_id", "observed_at");

--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "executor_fallback_policy" jsonb;
