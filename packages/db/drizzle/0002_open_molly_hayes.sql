ALTER TABLE "documents" ADD COLUMN "generated_by" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;