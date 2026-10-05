-- Retain legacy keys without guessing their subject, manager, project or grants.
ALTER TABLE "task_weaver"."api_keys"
  ADD COLUMN actor_id uuid REFERENCES "task_weaver"."auth_actors" (id) ON DELETE RESTRICT,
  ADD COLUMN issued_by_actor_id uuid REFERENCES "task_weaver"."auth_actors" (id) ON DELETE RESTRICT,
  ADD COLUMN grants jsonb,
  ADD COLUMN parent_key_id uuid REFERENCES "task_weaver"."api_keys" (id) ON DELETE RESTRICT,
  ADD COLUMN rotated_from_id uuid REFERENCES "task_weaver"."api_keys" (id) ON DELETE RESTRICT,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_actor_id uuid REFERENCES "task_weaver"."auth_actors" (id) ON DELETE RESTRICT,
  ADD CONSTRAINT api_keys_binding_check CHECK (
    (actor_id IS NULL AND issued_by_actor_id IS NULL AND grants IS NULL AND parent_key_id IS NULL) OR
    (actor_id IS NOT NULL AND issued_by_actor_id IS NOT NULL AND grants IS NOT NULL AND jsonb_typeof(grants) = 'array' AND jsonb_array_length(grants) BETWEEN 1 AND 100)),
  ADD CONSTRAINT api_keys_parent_check CHECK (parent_key_id IS NULL OR parent_key_id <> id),
  ADD CONSTRAINT api_keys_bound_hash_check CHECK (actor_id IS NULL OR key_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT api_keys_bound_expiry_check CHECK (actor_id IS NULL OR expires_at IS NULL OR (isfinite(expires_at) AND expires_at > created_at));
CREATE UNIQUE INDEX api_keys_bound_hash_unique ON "task_weaver"."api_keys" (key_hash) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX api_keys_rotation_unique ON "task_weaver"."api_keys" (rotated_from_id) WHERE rotated_from_id IS NOT NULL;
CREATE INDEX api_keys_actor_idx ON "task_weaver"."api_keys" (actor_id, revoked_at);
CREATE INDEX api_keys_parent_idx ON "task_weaver"."api_keys" (parent_key_id);
CREATE TABLE "task_weaver"."api_key_events" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key_id uuid NOT NULL REFERENCES "task_weaver"."api_keys" (id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES "task_weaver"."auth_actors" (id) ON DELETE RESTRICT, action text NOT NULL,
  previous_key_id uuid REFERENCES "task_weaver"."api_keys" (id) ON DELETE RESTRICT, created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT api_key_events_action_check CHECK (action IN ('issued', 'revoked', 'rotated'))
);
CREATE INDEX api_key_events_key_idx ON "task_weaver"."api_key_events" (key_id, created_at);
