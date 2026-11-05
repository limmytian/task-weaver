import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { activityLog, executionControls, requirements, type Database } from "@task-weaver/db";
import { ConflictError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockReassessmentGrant } from "./reassessment-grants";

/** Assessment is advisory: it never changes a control, resumes a run, or grants credentials. */
export const interruptedReassessmentInputSchema = z.object({
  grantId: z.string().uuid(), projectId: z.string().uuid(), requirementId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(), controlId: z.string().uuid(),
  expectedControlUpdatedAt: z.iso.datetime(),
  decision: z.enum(["accept", "escalate"]),
  inputs: z.array(z.object({ reference: z.string().trim().min(1).max(2000), observation: z.string().trim().min(1).max(4000) }).strict()).max(100),
  inputsAvailable: z.boolean(), uncertainExternalEffects: z.boolean(),
  rationale: z.string().trim().min(1).max(4000),
}).strict();

export function createInterruptedReassessmentService(context: VerifiedRequestContext) {
  return {
    async record(db: Database, value: z.input<typeof interruptedReassessmentInputSchema>) {
      const input = interruptedReassessmentInputSchema.parse(value);
      return db.transaction(async tx => {
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "assess_interrupted_execution" });
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId));
        if (!requirement || requirement.planRevision !== input.expectedRevision)
          throw new ConflictError("Plan changed; reassess the current revision", requirement?.planRevision ?? 0);
        const [control] = await tx.select().from(executionControls).where(and(eq(executionControls.id, input.controlId), eq(executionControls.requirementId, input.requirementId), eq(executionControls.projectId, input.projectId))).for("update");
        if (!control || control.updatedAt.toISOString() !== new Date(input.expectedControlUpdatedAt).toISOString())
          throw new ConflictError("Execution control changed; inspect the current stop", requirement.planRevision);
        // A recorded stop is an observation, not proof that an external process has stopped.
        const disposition = input.decision === "accept" && control.phase === "stopped" && input.inputsAvailable && input.inputs.length > 0 && !input.uncertainExternalEffects ? "accept" : "escalate";
        const [record] = await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId,
          action: "interrupted_execution_assessed", actorId: grant.agentId, actorType: "agent", metadata: {
            grantId: grant.id, planRevision: requirement.planRevision, controlId: control.id, runId: control.runId,
            observedPhase: control.phase, observedControlUpdatedAt: control.updatedAt.toISOString(),
            requestedDecision: input.decision, disposition, inputs: input.inputs, inputsAvailable: input.inputsAvailable,
            uncertainExternalEffects: input.uncertainExternalEffects, rationale: input.rationale,
          } }).returning();
        return { id: record!.id, disposition };
      });
    },
  };
}
