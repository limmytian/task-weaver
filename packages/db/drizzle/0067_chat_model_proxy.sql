ALTER TABLE "task_weaver"."ti_agent_model_configs" ADD COLUMN "proxy_mode" text DEFAULT 'inherit' NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_weaver"."ti_agent_model_configs" ADD COLUMN "proxy_url" text;
--> statement-breakpoint
ALTER TABLE "task_weaver"."ti_agent_model_configs" ADD CONSTRAINT "chat_model_proxy_valid" CHECK (
  "proxy_mode" IN ('inherit', 'direct', 'custom') AND ("proxy_mode" <> 'custom' OR "proxy_url" IS NOT NULL)
);
