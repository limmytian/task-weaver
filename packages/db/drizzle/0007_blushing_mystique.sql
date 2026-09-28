CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"status_message" text,
	"last_connected_at" timestamp with time zone,
	"tags" text[],
	"client_id" text,
	"expires_at" timestamp with time zone,
	"ttl" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid,
	"server_id" uuid,
	"tool_name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"called_by" text NOT NULL,
	"called_by_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"input_schema" jsonb,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"memory_type" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"tags" text[],
	"entity_type" text,
	"entity_id" uuid,
	"created_by" text NOT NULL,
	"created_by_type" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_tool_id_mcp_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "task_weaver"."mcp_tools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "task_weaver"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "task_weaver"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "task_weaver"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_servers_name" ON "mcp_servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_active" ON "mcp_servers" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_tool" ON "mcp_tool_calls" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_server" ON "mcp_tool_calls" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_calls_created" ON "mcp_tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_tools_server" ON "mcp_tools" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_tools_server_name" ON "mcp_tools" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "idx_memories_project" ON "memories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_memories_type" ON "memories" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "idx_memories_actor" ON "memories" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_memories_entity" ON "memories" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_memories_created" ON "memories" USING btree ("created_at");