CREATE TABLE task_weaver.execution_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  parent_credential_id uuid NOT NULL REFERENCES task_weaver.api_keys(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES task_weaver.auth_actors(id) ON DELETE RESTRICT,
  initiator_actor_id uuid NOT NULL REFERENCES task_weaver.auth_actors(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES task_weaver.projects(id) ON DELETE RESTRICT,
  requirement_id uuid NOT NULL REFERENCES task_weaver.requirements(id) ON DELETE RESTRICT,
  daemon_id uuid NOT NULL REFERENCES task_weaver.daemons(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  worker_index text NOT NULL,
  lease_generation text NOT NULL,
  purpose text NOT NULL,
  task_ids uuid[] NOT NULL,
  document_ids uuid[] NOT NULL,
  slice_ids uuid[] NOT NULL,
  repository_ids uuid[] NOT NULL,
  grants jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT execution_delegations_bounds_check CHECK (
    token_hash ~ '^[0-9a-f]{64}$' AND cardinality(task_ids) > 0
    AND purpose IN ('execute', 'review', 'merge', 'automation')
    AND lease_generation ~ '^[1-9][0-9]*$'
    AND expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX execution_delegations_active_run_unique ON task_weaver.execution_delegations(run_id, purpose) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX execution_delegations_subject_project_idx ON task_weaver.execution_delegations(actor_id, project_id);

--> statement-breakpoint
CREATE UNIQUE INDEX execution_delegations_token_hash_unique ON task_weaver.execution_delegations(token_hash);
