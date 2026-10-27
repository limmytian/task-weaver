CREATE TABLE "evidence_git_comparisons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "output_id" uuid NOT NULL REFERENCES "workflow_outputs"("id") ON DELETE CASCADE,
  "requirement_id" uuid NOT NULL REFERENCES "requirements"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL,
  "repository_key" text NOT NULL,
  "base_commit" text NOT NULL,
  "head_commit" text NOT NULL,
  "comparison_commit" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "idx_evidence_git_comparisons_output" ON "evidence_git_comparisons" ("output_id");
CREATE UNIQUE INDEX "idx_evidence_git_comparison_identity" ON "evidence_git_comparisons" ("output_id", "repository_id", "repository_key", "base_commit", "head_commit", "comparison_commit");
