-- Active legacy Ti leases cannot be proven stopped by the new worker authority.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "task_weaver"."ti_agent_runs"
    WHERE status IN ('queued', 'running', 'in_review')
  ) THEN
    RAISE EXCEPTION 'Inspect and resolve outstanding Ti runs before worker-attempt cutover';
  END IF;
END;
$$;
