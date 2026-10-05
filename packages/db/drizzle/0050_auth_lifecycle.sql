ALTER TABLE task_weaver.auth_sessions ADD COLUMN authenticated_at timestamptz;
--> statement-breakpoint
UPDATE task_weaver.auth_sessions SET authenticated_at = created_at;
--> statement-breakpoint
ALTER TABLE task_weaver.auth_sessions ALTER COLUMN authenticated_at SET DEFAULT now(), ALTER COLUMN authenticated_at SET NOT NULL;
--> statement-breakpoint
ALTER TABLE task_weaver.auth_sessions ADD COLUMN idle_timeout_seconds integer NOT NULL DEFAULT 86400;
--> statement-breakpoint
ALTER TABLE task_weaver.auth_sessions ADD CONSTRAINT auth_sessions_recency_check CHECK (isfinite(authenticated_at) AND idle_timeout_seconds > 0);
--> statement-breakpoint
CREATE TABLE task_weaver.auth_rate_limits (
  id text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  window_started_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE task_weaver.auth_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_id uuid REFERENCES task_weaver.auth_actors(id) ON DELETE RESTRICT,
  subject_actor_id uuid REFERENCES task_weaver.auth_actors(id) ON DELETE RESTRICT,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
