ALTER TABLE "workflow_outputs" ADD COLUMN "attachment_file_version_id" uuid REFERENCES "document_file_versions"("id") ON DELETE RESTRICT;
