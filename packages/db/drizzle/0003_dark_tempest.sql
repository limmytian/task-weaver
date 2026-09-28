CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb,
	"summary" text,
	"keywords" text[],
	"doc_type" text NOT NULL,
	"change_type" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_by_type" text NOT NULL,
	"change_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "task_weaver"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_doc_versions_doc" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_doc_versions_time" ON "document_versions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_doc_versions_unique" ON "document_versions" USING btree ("document_id","version");