ALTER TABLE "task_weaver"."ti_agent_model_configs" ADD COLUMN "encrypted_api_key" text;
--> statement-breakpoint
ALTER TABLE "task_weaver"."ti_agent_model_configs" ADD COLUMN "api_key_mask" text;
