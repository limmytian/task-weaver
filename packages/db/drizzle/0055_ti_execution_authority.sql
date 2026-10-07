ALTER TABLE task_weaver.ti_agent_runs ADD COLUMN execution_authority jsonb;
--> statement-breakpoint
ALTER TABLE task_weaver.execution_delegations ALTER COLUMN daemon_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE task_weaver.execution_delegations ADD COLUMN ti_run_id uuid REFERENCES task_weaver.ti_agent_runs(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE task_weaver.execution_delegations ADD CONSTRAINT execution_delegations_lease_kind_check CHECK (
  (purpose = 'automation' AND ti_run_id IS NOT NULL AND daemon_id IS NULL)
  OR (purpose <> 'automation' AND ti_run_id IS NULL AND daemon_id IS NOT NULL)
);
--> statement-breakpoint
