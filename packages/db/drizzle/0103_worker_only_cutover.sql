DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "task_weaver"."requirement_claims" WHERE daemon_id IS NOT NULL AND expires_at > clock_timestamp())
    OR EXISTS (SELECT 1 FROM "task_weaver"."daemons" WHERE status <> 'offline' AND last_heartbeat_at > clock_timestamp() - interval '2 minutes') THEN
    RAISE EXCEPTION 'Drain legacy daemon activity before worker-only cutover';
  END IF;
END;
$$;
--> statement-breakpoint
UPDATE "task_weaver"."projects" SET worker_mode = 'thin' WHERE worker_mode <> 'thin';
--> statement-breakpoint
ALTER TABLE "task_weaver"."projects" ALTER COLUMN worker_mode SET DEFAULT 'thin';
--> statement-breakpoint
ALTER TABLE "task_weaver"."projects" ADD CONSTRAINT "projects_worker_only" CHECK (worker_mode = 'thin');
