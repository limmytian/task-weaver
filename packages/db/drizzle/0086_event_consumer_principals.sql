-- Legacy checkpoints have no verifiable owner and cannot safely be reassigned.
DELETE FROM "task_weaver"."event_consumers";
--> statement-breakpoint
DROP INDEX "task_weaver"."event_consumers_project_name";
ALTER TABLE "task_weaver"."event_consumers" ADD COLUMN "principal_type" text NOT NULL;
ALTER TABLE "task_weaver"."event_consumers" ADD COLUMN "principal_id" text NOT NULL;
ALTER TABLE "task_weaver"."event_consumers" ADD CONSTRAINT "event_consumer_principal_valid" CHECK (length("principal_id") > 0 AND "principal_type" IN ('human', 'agent'));
CREATE UNIQUE INDEX "event_consumers_project_principal_name" ON "task_weaver"."event_consumers" ("project_id", "principal_type", "principal_id", "name");
