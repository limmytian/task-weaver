CREATE TABLE IF NOT EXISTS "assistant_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "requirement_id" uuid,
  "task_id" uuid,
  "schedule_id" uuid,
  "title" text,
  "context_kind" text DEFAULT 'global' NOT NULL,
  "created_by" text NOT NULL,
  "created_by_type" "task_weaver"."actor_type" NOT NULL,
  "last_message_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "context_snapshot" jsonb,
  "pi_agent_run_id" uuid,
  "provider" text,
  "model" text,
  "metadata" jsonb,
  "created_by" text NOT NULL,
  "created_by_type" "task_weaver"."actor_type" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid,
  "action_type" text NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "target_type" text,
  "target_id" uuid,
  "payload" jsonb NOT NULL,
  "preview" text,
  "approval_actor_id" text,
  "approval_actor_type" "task_weaver"."actor_type",
  "approved_at" timestamp with time zone,
  "execution_result" jsonb,
  "activity_log_id" uuid,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "executed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_conversations_project_id_projects_id_fk'
  ) THEN
    ALTER TABLE "assistant_conversations"
      ADD CONSTRAINT "assistant_conversations_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_conversations_requirement_id_requirements_id_fk'
  ) THEN
    ALTER TABLE "assistant_conversations"
      ADD CONSTRAINT "assistant_conversations_requirement_id_requirements_id_fk"
      FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_conversations_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE "assistant_conversations"
      ADD CONSTRAINT "assistant_conversations_task_id_tasks_id_fk"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_conversations_schedule_id_schedules_id_fk'
  ) THEN
    ALTER TABLE "assistant_conversations"
      ADD CONSTRAINT "assistant_conversations_schedule_id_schedules_id_fk"
      FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_messages_conversation_id_assistant_conversations_id_fk'
  ) THEN
    ALTER TABLE "assistant_messages"
      ADD CONSTRAINT "assistant_messages_conversation_id_assistant_conversations_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_messages_pi_agent_run_id_pi_agent_runs_id_fk'
  ) THEN
    ALTER TABLE "assistant_messages"
      ADD CONSTRAINT "assistant_messages_pi_agent_run_id_pi_agent_runs_id_fk"
      FOREIGN KEY ("pi_agent_run_id") REFERENCES "pi_agent_runs"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_conversation_id_assistant_conversations_id_fk'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_conversation_id_assistant_conversations_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_message_id_assistant_messages_id_fk'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_message_id_assistant_messages_id_fk"
      FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_activity_log_id_activity_log_id_fk'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_activity_log_id_activity_log_id_fk"
      FOREIGN KEY ("activity_log_id") REFERENCES "activity_log"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_project" ON "assistant_conversations" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_requirement" ON "assistant_conversations" ("requirement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_task" ON "assistant_conversations" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_schedule" ON "assistant_conversations" ("schedule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_actor" ON "assistant_conversations" ("created_by", "created_by_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_conversations_last_message" ON "assistant_conversations" ("last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_messages_conversation" ON "assistant_messages" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_messages_pi_run" ON "assistant_messages" ("pi_agent_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_messages_created" ON "assistant_messages" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_actions_conversation" ON "assistant_actions" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_actions_message" ON "assistant_actions" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_actions_status" ON "assistant_actions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assistant_actions_target" ON "assistant_actions" ("target_type", "target_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_conversations_context_kind'
  ) THEN
    ALTER TABLE "assistant_conversations"
      ADD CONSTRAINT "assistant_conversations_context_kind"
      CHECK ("context_kind" IN ('global', 'project', 'requirement', 'task', 'schedule'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_messages_role'
  ) THEN
    ALTER TABLE "assistant_messages"
      ADD CONSTRAINT "assistant_messages_role"
      CHECK ("role" IN ('user', 'assistant', 'system', 'tool'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_action_type'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_action_type"
      CHECK ("action_type" IN (
        'create_task',
        'update_task',
        'create_schedule',
        'pause_schedule',
        'queue_pi_run',
        'add_comment',
        'add_note',
        'draft_document'
      ));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_status'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_status"
      CHECK ("status" IN ('proposed', 'approved', 'rejected', 'executing', 'succeeded', 'failed', 'cancelled'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_actions_target_type'
  ) THEN
    ALTER TABLE "assistant_actions"
      ADD CONSTRAINT "assistant_actions_target_type"
      CHECK (
        "target_type" IS NULL
        OR "target_type" IN ('project', 'requirement', 'task', 'schedule', 'document', 'pi_agent_run')
      );
  END IF;
END $$;
--> statement-breakpoint
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
        'assistant_action'
      ));
  END IF;
END $$;
