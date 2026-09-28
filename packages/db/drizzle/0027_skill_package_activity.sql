DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_entity_type_check'
  ) THEN
    ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_entity_type_check";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_entity_type_check'
  ) THEN
    ALTER TABLE "activity_log"
      ADD CONSTRAINT "activity_log_entity_type_check"
      CHECK ("entity_type" IN (
        'project',
        'task',
        'document',
        'requirement',
        'schedule',
        'pi_agent_model_config',
        'pi_agent_policy',
        'pi_agent_run',
        'assistant_conversation',
        'assistant_message',
        'assistant_action',
        'skill_package'
      ));
  END IF;
END $$;
