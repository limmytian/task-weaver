CREATE TABLE task_weaver.auth_migration_receipts (
  id uuid PRIMARY KEY,
  manifest_hash text NOT NULL,
  inventory_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
