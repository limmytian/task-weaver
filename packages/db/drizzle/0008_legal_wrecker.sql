CREATE TABLE "daemons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"capabilities" text[],
	"current_task_id" uuid,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daemons" ADD CONSTRAINT "daemons_current_task_id_tasks_id_fk" FOREIGN KEY ("current_task_id") REFERENCES "task_weaver"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_daemons_status" ON "daemons" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_daemons_last_heartbeat" ON "daemons" USING btree ("last_heartbeat_at");