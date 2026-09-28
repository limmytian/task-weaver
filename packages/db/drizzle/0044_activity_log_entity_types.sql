DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'activity_log_entity_type_check'
      AND conrelid = 'task_weaver.activity_log'::regclass
  ) THEN
    ALTER TABLE "task_weaver"."activity_log"
      DROP CONSTRAINT "activity_log_entity_type_check";
  END IF;

  ALTER TABLE "task_weaver"."activity_log"
    ADD CONSTRAINT "activity_log_entity_type_check"
    CHECK ("entity_type" IN (
      'project',
      'task',
      'document',
      'embedding_profile',
      'embedding_generation',
      'embedding_job',
      'requirement',
      'schedule',
      'pi_agent_model_config',
      'pi_agent_policy',
      'pi_agent_run',
      'assistant_conversation',
      'assistant_message',
      'assistant_action',
      'skill_package',
      'repository',
      'daemon'
    ));
END $$;
