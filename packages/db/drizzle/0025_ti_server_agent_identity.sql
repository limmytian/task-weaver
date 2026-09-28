UPDATE "tasks"
SET "assignee" = 'task-weaver:ti-agent'
WHERE "assignee" = 'task-weaver:pi-agent'
  AND "assignee_type" = 'agent';

UPDATE "schedules"
SET "assigned_executor" = 'task-weaver:ti-agent'
WHERE "assigned_executor" = 'task-weaver:pi-agent'
  AND "assigned_executor_type" = 'agent';

UPDATE "pi_agent_runs"
SET "assigned_agent_id" = 'task-weaver:ti-agent'
WHERE "assigned_agent_id" = 'task-weaver:pi-agent'
  AND "assigned_agent_type" = 'agent';
