ALTER TABLE agent_usage_runs ALTER COLUMN project_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_usage_runs ALTER COLUMN requirement_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_usage_runs ADD COLUMN personal_owner_id text, ADD COLUMN personal_owner_type text,
  ADD COLUMN conversation_id uuid, ADD COLUMN message_id uuid, ADD COLUMN operation_ids jsonb, ADD COLUMN model_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE agent_usage_runs ADD CONSTRAINT agent_usage_ownership CHECK (
  (project_id IS NOT NULL AND personal_owner_id IS NULL AND personal_owner_type IS NULL)
  OR (project_id IS NULL AND requirement_id IS NULL AND task_id IS NULL AND personal_owner_id IS NOT NULL AND personal_owner_type IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE INDEX idx_agent_usage_personal_time ON agent_usage_runs (personal_owner_id, personal_owner_type, started_at);
--> statement-breakpoint
CREATE INDEX idx_agent_usage_conversation ON agent_usage_runs (conversation_id, started_at);
