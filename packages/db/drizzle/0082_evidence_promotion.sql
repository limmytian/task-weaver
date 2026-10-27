ALTER TABLE "workflow_outputs" ADD COLUMN "promoted_document_id" uuid REFERENCES "documents"("id") ON DELETE RESTRICT;
