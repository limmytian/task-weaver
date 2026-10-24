ALTER TABLE requirements ADD COLUMN plan_revision integer DEFAULT 0 NOT NULL;
ALTER TABLE requirements ADD COLUMN evidence_needs_review boolean DEFAULT false NOT NULL;
CREATE TABLE execution_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  daemon_id uuid NOT NULL,
  run_id uuid NOT NULL,
  revision integer NOT NULL,
  reason text NOT NULL,
  phase text NOT NULL DEFAULT 'pending',
  workspace jsonb,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_execution_controls_run ON execution_controls(run_id);
CREATE INDEX idx_execution_controls_daemon ON execution_controls(daemon_id, updated_at);
CREATE INDEX idx_execution_controls_requirement ON execution_controls(requirement_id, created_at);

CREATE TABLE execution_synchronizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, repository_id uuid NOT NULL,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE, plan_revision integer NOT NULL,
  remote_tip text NOT NULL, local_head text NOT NULL,
  fetched_at timestamptz NOT NULL, verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_execution_sync_run_repository ON execution_synchronizations(run_id, repository_id);
CREATE INDEX idx_execution_sync_requirement ON execution_synchronizations(requirement_id, verified_at);

ALTER TABLE requirements ADD COLUMN recovery_policy jsonb NOT NULL DEFAULT '{"retrySafe":false,"maxAttempts":3,"graceMs":120000}';
ALTER TABLE requirements ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE workflow_outputs ADD COLUMN plan_revision integer NOT NULL DEFAULT 0;
