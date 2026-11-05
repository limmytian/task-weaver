ALTER TABLE "task_weaver"."reassessment_grants" DROP CONSTRAINT "reassessment_grants_operations_check";
--> statement-breakpoint
ALTER TABLE "task_weaver"."reassessment_grants" ADD CONSTRAINT "reassessment_grants_operations_check" CHECK (cardinality("operations") > 0 AND "operations" <@ ARRAY['revalidate_evidence', 'assess_interrupted_execution']::text[] AND array_position("operations", NULL) IS NULL);
