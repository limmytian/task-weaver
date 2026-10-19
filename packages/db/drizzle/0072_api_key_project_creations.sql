CREATE TABLE "api_key_project_creations" (
  "key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("key_id", "project_id")
);
