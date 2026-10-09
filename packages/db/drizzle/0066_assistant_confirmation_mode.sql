ALTER TABLE "task_weaver"."ti_agent_policies"
  ADD CONSTRAINT "ti_agent_policies_assistant_auto_mode"
  CHECK ("assistant_auto_mode" IN ('disabled', 'dry_run', 'confirm', 'live'));
