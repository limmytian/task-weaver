ALTER TABLE "task_weaver"."assistant_actions"
  DROP CONSTRAINT IF EXISTS "assistant_actions_action_type";
--> statement-breakpoint
ALTER TABLE "task_weaver"."assistant_actions"
  ADD CONSTRAINT "assistant_actions_action_type"
  CHECK ("action_type" IN ('create_task', 'update_task', 'create_schedule',
    'pause_schedule', 'queue_ti_run', 'add_comment', 'add_note', 'draft_document',
    'platform_operation'));
