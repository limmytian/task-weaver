import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { activityLog, executionControls, requirementClaims, requirements, type Database } from "@task-weaver/db";
import { ConflictError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resolveWorkflowInputs } from "./workflow-input-resolution";
import { lockReassessmentGrant } from "./reassessment-grants";

/** Assessment is advisory: it never changes a control, resumes a run, or grants credentials. */
export const interruptedReassessmentInputSchema = z.object({
  grantId: z.string().uuid(), projectId: z.string().uuid(), requirementId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(), controlId: z.string().uuid(),
  expectedControlUpdatedAt: z.iso.datetime(), expectedRunId: z.string().uuid(), expectedLeaseGeneration: z.number().int().nonnegative(),
  decision: z.enum(["accept", "escalate"]),
  inputs: z.array(z.object({ type: z.literal("workflow_input"), inputId: z.string().uuid() }).strict()).max(100),
  notes: z.string().trim().max(4000).optional(), uncertainExternalEffects: z.boolean(),
  rationale: z.string().trim().min(1).max(4000),
}).strict();

export function createInterruptedReassessmentService(context: VerifiedRequestContext) {
  return {
    async record(db: Database, value: z.input<typeof interruptedReassessmentInputSchema>) {
      const input = interruptedReassessmentInputSchema.parse(value);
      return db.transaction(async tx => {
        const resolved = await resolveWorkflowInputs(tx, context, input.requirementId);
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "assess_interrupted_execution", requirementAlreadyLocked: true });
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId));
        if (!requirement || requirement.planRevision !== input.expectedRevision || requirement.leaseGeneration !== input.expectedLeaseGeneration)
          throw new ConflictError("Plan changed; reassess the current revision", requirement?.planRevision ?? 0);
        const [control] = await tx.select().from(executionControls).where(and(eq(executionControls.id, input.controlId), eq(executionControls.requirementId, input.requirementId), eq(executionControls.projectId, input.projectId))).for("update");
        if (!control || control.runId !== input.expectedRunId || control.updatedAt.toISOString() !== new Date(input.expectedControlUpdatedAt).toISOString())
          throw new ConflictError("Execution control changed; inspect the current stop", requirement.planRevision);
        const [claim] = await tx.select().from(requirementClaims).where(eq(requirementClaims.requirementId, input.requirementId)).for("share");
        const runMatchesGeneration = claim?.id === control.runId && claim.generation === requirement.leaseGeneration && claim.daemonId === control.daemonId;
        const ids = new Set(input.inputs.map(item => item.inputId));
        const inputsAvailable = ids.size > 0 && ids.size === input.inputs.length && ids.size === resolved.length && resolved.every(item => ids.has(item.inputId) && item.status === "available");
        const evidence = [...resolved, ...input.inputs.filter(item => !resolved.some(row => row.inputId === item.inputId)).map(item => ({ inputId: item.inputId, status: "unavailable" as const, reason: "missing" as const }))];
        // A recorded stop is an observation, not proof that an external process has stopped.
        const disposition = input.decision === "accept" && control.phase === "stopped" && runMatchesGeneration && inputsAvailable && !input.uncertainExternalEffects ? "accept" : "escalate";
        const [record] = await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId,
          action: "interrupted_execution_assessed", actorId: grant.agentId, actorType: "agent", metadata: {
            grantId: grant.id, planRevision: requirement.planRevision, controlId: control.id, runId: control.runId,
            leaseGeneration: requirement.leaseGeneration, runMatchesGeneration, observedPhase: control.phase, observedControlUpdatedAt: control.updatedAt.toISOString(),
            requestedDecision: input.decision, disposition, inputs: evidence, inputsAvailable, notes: input.notes,
            uncertainExternalEffects: input.uncertainExternalEffects, rationale: input.rationale,
          } }).returning();
        return { id: record!.id, disposition };
      });
    },
  };
}
