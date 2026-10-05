-- Add identity storage without interpreting legacy attribution or granting existing actors access.
CREATE TABLE "task_weaver"."auth_actors" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  display_name text NOT NULL,
  status text DEFAULT 'disabled' NOT NULL,
  managed_by_actor_id uuid,
  managed_by_actor_type text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT auth_actors_id_type_unique UNIQUE (id, type),
  CONSTRAINT auth_actors_type_check CHECK (type IN ('human', 'agent')),
  CONSTRAINT auth_actors_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT auth_actors_manager_check CHECK (
    (type = 'human' AND managed_by_actor_id IS NULL AND managed_by_actor_type IS NULL) OR
    (type = 'agent' AND managed_by_actor_id IS NOT NULL AND managed_by_actor_type IS NOT NULL AND managed_by_actor_type = 'human')),
  CONSTRAINT auth_actors_manager_fk FOREIGN KEY (managed_by_actor_id, managed_by_actor_type) REFERENCES "task_weaver"."auth_actors" (id, type) ON DELETE RESTRICT
);
CREATE INDEX auth_actors_manager_idx ON "task_weaver"."auth_actors" (managed_by_actor_id);
CREATE TABLE "task_weaver"."auth_users" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL UNIQUE, actor_type text DEFAULT 'human' NOT NULL,
  name text NOT NULL, email text NOT NULL, email_verified boolean DEFAULT false NOT NULL, image text,
  status text DEFAULT 'disabled' NOT NULL, instance_role text DEFAULT 'user' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT auth_users_human_actor_fk FOREIGN KEY (actor_id, actor_type) REFERENCES "task_weaver"."auth_actors" (id, type) ON DELETE RESTRICT,
  CONSTRAINT auth_users_human_check CHECK (actor_type = 'human'),
  CONSTRAINT auth_users_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT auth_users_role_check CHECK (instance_role IN ('user', 'admin'))
);
CREATE UNIQUE INDEX auth_users_email_unique ON "task_weaver"."auth_users" (lower(email));
CREATE INDEX auth_users_admin_idx ON "task_weaver"."auth_users" (instance_role, status);
CREATE TABLE "task_weaver"."auth_accounts" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "task_weaver"."auth_users" (id) ON DELETE RESTRICT,
  account_id text NOT NULL, provider_id text NOT NULL, password text, access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT auth_accounts_provider_identity_unique UNIQUE (provider_id, account_id),
  CONSTRAINT auth_accounts_user_provider_unique UNIQUE (user_id, provider_id),
  CONSTRAINT auth_accounts_local_check CHECK (provider_id = 'credential' AND password IS NOT NULL AND access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL)
);
CREATE TABLE "task_weaver"."auth_sessions" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "task_weaver"."auth_users" (id) ON DELETE RESTRICT,
  token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz, last_seen_at timestamptz, ip_address text, user_agent text,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT auth_sessions_lifetime_check CHECK (isfinite(absolute_expires_at) AND isfinite(idle_expires_at) AND isfinite(expires_at) AND absolute_expires_at > created_at AND idle_expires_at > created_at AND expires_at > created_at AND expires_at <= absolute_expires_at AND idle_expires_at <= absolute_expires_at)
);
CREATE INDEX auth_sessions_user_idx ON "task_weaver"."auth_sessions" (user_id, revoked_at);
CREATE INDEX auth_sessions_expiry_idx ON "task_weaver"."auth_sessions" (expires_at);
CREATE TABLE "task_weaver"."auth_verifications" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX auth_verifications_identifier_idx ON "task_weaver"."auth_verifications" (identifier);
CREATE TABLE "task_weaver"."project_memberships" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES "task_weaver"."projects" (id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL, actor_type text NOT NULL, role text NOT NULL, explicit_permissions text[] DEFAULT ARRAY[]::text[] NOT NULL,
  removed_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT project_memberships_actor_fk FOREIGN KEY (actor_id, actor_type) REFERENCES "task_weaver"."auth_actors" (id, type) ON DELETE RESTRICT,
  CONSTRAINT project_memberships_project_actor_unique UNIQUE (project_id, actor_id),
  CONSTRAINT project_memberships_role_check CHECK (role IN ('owner', 'maintainer', 'member', 'viewer') AND (role <> 'owner' OR actor_type = 'human')),
  CONSTRAINT project_memberships_permissions_check CHECK (explicit_permissions <@ ARRAY['execution.run', 'execution.review', 'execution.merge', 'mcp.invoke']::text[])
);
CREATE INDEX project_memberships_actor_idx ON "task_weaver"."project_memberships" (actor_id, removed_at);
CREATE INDEX project_memberships_owner_idx ON "task_weaver"."project_memberships" (project_id, role, removed_at);
CREATE TABLE "task_weaver"."auth_instance_state" (
  id text PRIMARY KEY DEFAULT 'instance', initialized_by_user_id uuid REFERENCES "task_weaver"."auth_users" (id) ON DELETE RESTRICT, initialized_at timestamptz,
  CONSTRAINT auth_instance_state_singleton_check CHECK (id = 'instance'),
  CONSTRAINT auth_instance_state_initialized_check CHECK ((initialized_by_user_id IS NULL) = (initialized_at IS NULL))
);
INSERT INTO "task_weaver"."auth_instance_state" (id) VALUES ('instance');
CREATE TABLE "task_weaver"."auth_activations" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "task_weaver"."auth_users" (id) ON DELETE RESTRICT,
  issued_by_user_id uuid NOT NULL REFERENCES "task_weaver"."auth_users" (id) ON DELETE RESTRICT, token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT auth_activations_purpose_check CHECK (purpose IN ('invite', 'recovery')),
  CONSTRAINT auth_activations_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_activations_expiry_check CHECK (isfinite(expires_at) AND expires_at > created_at)
);
CREATE INDEX auth_activations_user_idx ON "task_weaver"."auth_activations" (user_id);
