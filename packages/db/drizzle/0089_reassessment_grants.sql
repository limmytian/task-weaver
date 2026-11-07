CREATE TABLE "task_weaver"."reassessment_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "task_weaver"."projects"("id") ON DELETE CASCADE,
  "requirement_id" uuid REFERENCES "task_weaver"."requirements"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "task_weaver"."auth_actors"("id") ON DELETE RESTRICT,
  "created_by" uuid NOT NULL REFERENCES "task_weaver"."auth_actors"("id") ON DELETE RESTRICT,
  "operations" text[] NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by" uuid REFERENCES "task_weaver"."auth_actors"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reassessment_grants_operations_check" CHECK (cardinality("operations") > 0 AND "operations" <@ ARRAY['revalidate_evidence']::text[] AND array_position("operations", NULL) IS NULL),
  CONSTRAINT "reassessment_grants_revocation_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
CREATE INDEX "reassessment_grants_scope_idx" ON "task_weaver"."reassessment_grants" ("project_id", "agent_id");
