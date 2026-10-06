ALTER TABLE task_weaver."webhooks" ADD COLUMN "binding_id" uuid;
--> statement-breakpoint
ALTER TABLE task_weaver."webhook_deliveries" ADD COLUMN "binding_id" uuid;
--> statement-breakpoint
ALTER TABLE task_weaver."webhooks" ADD COLUMN "owner_actor_id" uuid REFERENCES task_weaver.auth_actors(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE task_weaver."webhooks" ADD COLUMN "credential_kind" text;
--> statement-breakpoint
ALTER TABLE task_weaver."webhooks" ADD COLUMN "credential_id" uuid;
--> statement-breakpoint
ALTER TABLE task_weaver."webhooks" ADD COLUMN "authority_ceiling" jsonb;
--> statement-breakpoint
ALTER TABLE task_weaver."webhooks" ADD CONSTRAINT "webhooks_authority_binding_check" CHECK (
  (binding_id IS NULL AND owner_actor_id IS NULL AND credential_kind IS NULL AND credential_id IS NULL AND authority_ceiling IS NULL)
  OR (binding_id IS NOT NULL AND owner_actor_id IS NOT NULL AND credential_kind IS NOT NULL AND credential_kind IN ('session', 'api_key') AND credential_id IS NOT NULL AND authority_ceiling IS NOT NULL AND jsonb_typeof(authority_ceiling) = 'array')
);
--> statement-breakpoint
-- Legacy outbound subscriptions have no verified owner and must be explicitly reauthorized.
UPDATE task_weaver."webhooks" SET active = false WHERE owner_actor_id IS NULL;
