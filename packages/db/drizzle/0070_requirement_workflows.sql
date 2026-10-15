ALTER TABLE projects ADD COLUMN default_workflow jsonb;
--> statement-breakpoint
ALTER TABLE daemons ADD COLUMN node_id text;
--> statement-breakpoint
ALTER TABLE execution_delegations DROP CONSTRAINT execution_delegations_bounds_check;
--> statement-breakpoint
ALTER TABLE execution_delegations ADD CONSTRAINT execution_delegations_bounds_check CHECK (
  token_hash ~ '^[0-9a-f]{64}$' AND (cardinality(task_ids) > 0 OR purpose IN ('delivery', 'review', 'merge'))
  AND purpose IN ('execute', 'delivery', 'review', 'merge', 'automation') AND lease_generation ~ '^[1-9][0-9]*$'
  AND expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
);
--> statement-breakpoint
ALTER TABLE requirements ADD COLUMN workflow jsonb;
--> statement-breakpoint
ALTER TABLE requirements ADD COLUMN workflow_source text;
--> statement-breakpoint
ALTER TABLE requirements ADD COLUMN workflow_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE requirements ADD COLUMN workflow_state jsonb;
--> statement-breakpoint
ALTER TABLE requirements ADD COLUMN workflow_state_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE workflow_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  workflow_revision integer NOT NULL DEFAULT 1,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  execution_slice_id uuid REFERENCES execution_slices(id) ON DELETE SET NULL,
  requirement_repository_id uuid REFERENCES requirement_repositories(id) ON DELETE SET NULL,
  type text NOT NULL,
  reference_id uuid,
  url text,
  node_id text,
  relative_path text,
  size_bytes bigint,
  sha256 text,
  head_commit text,
  summary text,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'missing', 'changed', 'retired')),
  verified_at timestamptz,
  retain_until timestamptz,
  created_by text NOT NULL,
  created_by_type actor_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_outputs_type_check CHECK (type IN ('comment', 'attachment', 'url', 'local', 'git_branch', 'git_pr')),
  CONSTRAINT workflow_outputs_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0)
);
--> statement-breakpoint
CREATE INDEX idx_workflow_outputs_requirement ON workflow_outputs(requirement_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_workflow_outputs_node ON workflow_outputs(node_id);
--> statement-breakpoint
CREATE TABLE workflow_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id uuid NOT NULL REFERENCES workflow_outputs(id) ON DELETE RESTRICT,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  execution_slice_id uuid REFERENCES execution_slices(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_workflow_inputs_requirement ON workflow_inputs(requirement_id);
--> statement-breakpoint
CREATE INDEX idx_workflow_inputs_output ON workflow_inputs(output_id);
