CREATE TABLE "task_weaver"."managed_child_observations" (
  "run_id" uuid PRIMARY KEY NOT NULL,
  "requirement_id" uuid NOT NULL REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "daemon_id" uuid NOT NULL,
  "lease_generation" integer NOT NULL CHECK ("lease_generation" >= 0),
  "pid" integer NOT NULL CHECK ("pid" > 0),
  "process_identity" text NOT NULL CHECK (length("process_identity") BETWEEN 1 AND 512),
  "bound_at" timestamp with time zone DEFAULT now() NOT NULL,
  "exited_at" timestamp with time zone,
  "exit_status" integer,
  "signal" text
);
