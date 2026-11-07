import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, executionControls, requirementClaims, requirements, type Database } from "@task-weaver/db";
import { ConflictError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { resolveWorkflowInputs } from "./workflow-input-resolution";
import { lockReassessmentGrant } from "./reassessment-grants";
import { requireResource, resourceAuthority } from "./resource-authorization";

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

export const interruptedReassessmentConsumeSchema = z.object({
  grantId: z.string().uuid(), projectId: z.string().uuid(), requirementId: z.string().uuid(), assessmentId: z.string().uuid(),
}).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function createInterruptedReassessmentService(context: VerifiedRequestContext) {
  return {
    /** Consume the assessment as an audit decision only; this does not start or lease execution. */
    async consume(db: Database, value: z.input<typeof interruptedReassessmentConsumeSchema>) {
      const input = interruptedReassessmentConsumeSchema.parse(value);
      return db.transaction(async tx => {
        const resolved = await resolveWorkflowInputs(tx, context, input.requirementId, { exclusiveRequirements: true });
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "assess_interrupted_execution", requirementAlreadyLocked: true });
        const authority = await resourceAuthority(tx, context);
        await requireResource(tx as unknown as Database, authority, "requirement", input.requirementId, "resource.write");
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId)).for("update");
        const [assessment] = await tx.select().from(activityLog).where(and(eq(activityLog.id, input.assessmentId), eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, input.requirementId), eq(activityLog.action, "interrupted_execution_assessed"))).for("share");
        const m = assessment?.metadata as Record<string, unknown> | undefined;
        const fail = () => { throw new ConflictError("Assessment or execution evidence changed; reassess or escalate", requirement?.planRevision ?? 0); };
        if (!requirement || !assessment || assessment.actorType !== "agent" || assessment.actorId !== grant.agentId || m?.grantId !== grant.id || m.disposition !== "accept" || m.requestedDecision !== "accept" || m.uncertainExternalEffects !== false || m.inputsAvailable !== true || m.runMatchesGeneration !== true || m.observedPhase !== "stopped" || m.planRevision !== requirement.planRevision || m.leaseGeneration !== requirement.leaseGeneration || typeof m.controlId !== "string" || typeof m.runId !== "string" || typeof m.observedControlUpdatedAt !== "string") fail();
        // The control phase is a supervisor report, not independently verifiable
        // evidence of managed-child termination. No authoritative stop evidence is
        // currently persisted by this protocol, so consumption must fail closed.
        fail();
        const [control] = await tx.select().from(executionControls).where(and(eq(executionControls.id, m!.controlId as string), eq(executionControls.requirementId, input.requirementId), eq(executionControls.projectId, input.projectId))).for("update");
        const [latest] = await tx.select({ id: executionControls.id }).from(executionControls).where(eq(executionControls.requirementId, input.requirementId)).orderBy(desc(executionControls.createdAt), desc(executionControls.id)).limit(1);
        const [claim] = await tx.select().from(requirementClaims).where(eq(requirementClaims.requirementId, input.requirementId)).for("update");
        const [consumed] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, input.requirementId), eq(activityLog.action, "interrupted_execution_assessment_consumed"), sql`${activityLog.metadata}->>'controlId' = ${m!.controlId as string}`));
        // Serializing on the requirement also serializes duplicate consumption. A prior
        // consumption for this control cannot be reused.
        if (grant.expiresAt <= new Date() || ["done", "cancelled", "archived"].includes(requirement!.status) || consumed || !control || latest?.id !== control.id || control.runId !== m!.runId || control.phase !== "stopped" || control.updatedAt.toISOString() !== m!.observedControlUpdatedAt || !claim || claim.id !== control.runId || claim.daemonId !== control.daemonId || claim.generation !== requirement!.leaseGeneration || claim.expiresAt <= new Date() || !Array.isArray(m!.inputs) || resolved.length === 0 || resolved.some(item => item.status !== "available") || canonical(resolved) !== canonical(m!.inputs)) fail();
        const [audit] = await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId, action: "interrupted_execution_assessment_consumed", actorId: grant.agentId, actorType: "agent", metadata: { assessmentId: assessment!.id, grantId: grant.id, planRevision: requirement!.planRevision, controlId: control!.id, runId: control!.runId, leaseGeneration: requirement!.leaseGeneration } }).returning();
        return { consumed: true as const, auditId: audit!.id };
      });
    },
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
        // A control phase and a live claim do not establish that the managed child exited.
        // Until fenced server-side exit evidence is available, even an otherwise
        // acceptable assessment must request human review.
        const managedChildExitEvidence = "unavailable" as const;
        const disposition = "escalate" as const;
        const [record] = await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId,
          action: "interrupted_execution_assessed", actorId: grant.agentId, actorType: "agent", metadata: {
            grantId: grant.id, planRevision: requirement.planRevision, controlId: control.id, runId: control.runId,
            leaseGeneration: requirement.leaseGeneration, runMatchesGeneration, observedPhase: control.phase, observedControlUpdatedAt: control.updatedAt.toISOString(),
            requestedDecision: input.decision, disposition, managedChildExitEvidence, inputs: evidence, inputsAvailable, notes: input.notes,
            uncertainExternalEffects: input.uncertainExternalEffects, rationale: input.rationale,
          } }).returning();
        return { id: record!.id, disposition };
      });
    },
  };
}
