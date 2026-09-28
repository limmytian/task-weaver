ALTER TABLE "documents" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "keywords" text[];--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "doc_type" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "reading_time_min" integer;--> statement-breakpoint
CREATE INDEX "idx_docs_doc_type" ON "documents" USING btree ("doc_type");