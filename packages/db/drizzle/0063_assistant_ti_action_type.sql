ALTER TABLE "task_weaver"."assistant_actions"
  DROP CONSTRAINT IF EXISTS "assistant_actions_action_type";
--> statement-breakpoint
UPDATE "task_weaver"."assistant_actions"
SET "action_type" = 'queue_ti_run',
    "status" = CASE WHEN "status" = 'approved' THEN 'proposed' ELSE "status" END,
    "approval_actor_id" = CASE WHEN "status" = 'approved' THEN NULL ELSE "approval_actor_id" END,
    "approval_actor_type" = CASE WHEN "status" = 'approved' THEN NULL ELSE "approval_actor_type" END,
    "approved_at" = CASE WHEN "status" = 'approved' THEN NULL ELSE "approved_at" END
WHERE "action_type" = 'queue_pi_run';
--> statement-breakpoint
ALTER TABLE "task_weaver"."assistant_actions"
  ADD CONSTRAINT "assistant_actions_action_type"
  CHECK ("action_type" IN ('create_task', 'update_task', 'create_schedule',
    'pause_schedule', 'queue_ti_run', 'add_comment', 'add_note', 'draft_document'));
