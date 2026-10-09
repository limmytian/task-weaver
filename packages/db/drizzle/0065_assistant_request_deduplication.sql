CREATE UNIQUE INDEX "idx_assistant_messages_request"
  ON "task_weaver"."assistant_messages"
  ("created_by", "created_by_type", ("metadata"->>'requestId'))
  WHERE "role" = 'user' AND "metadata"->>'requestId' IS NOT NULL;
