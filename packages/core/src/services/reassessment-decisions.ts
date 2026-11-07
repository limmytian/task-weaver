import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { emitDurable } from "./durable-events";
import { activityLog, requirements, workflowOutputs, type Database } from "@task-weaver/db";
import { AuthorizationError, ConflictError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockReassessmentGrant } from "./reassessment-grants";
import { lockIdentityLifecycle } from "./auth-security";
import { resourceAuthority, requireResource } from "./resource-authorization";
import { reassessmentDisposition } from "./agent-reassessment-policy";

export const reassessmentDecisionInputSchema = z.object({
  grantId: z.string().uuid(), projectId: z.string().uuid(), requirementId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(), decision: z.enum(["accept", "escalate"]),
  evidence: z.array(z.object({ outputId: z.string().uuid(), rationale: z.string().trim().min(1).max(2000) }).strict()).max(100),
  rationale: z.string().trim().min(1).max(4000), inputsAvailable: z.boolean(), uncertainExternalEffects: z.boolean(),
}).strict();

export const reassessmentApplyInputSchema = z.object({
  projectId: z.string().uuid(), requirementId: z.string().uuid(), grantId: z.string().uuid(), decisionId: z.string().uuid(),
}).strict();

function evidenceFingerprint(outputs: (typeof workflowOutputs.$inferSelect)[]) {
  return createHash("sha256").update(JSON.stringify([...outputs].sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

/** Records historical evidence review only. This does not resume or recover an execution. */
export function createReassessmentDecisionService(context: VerifiedRequestContext) {
  return {
    async inspect(db: Database, requirementId: string) {
      z.string().uuid().parse(requirementId);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const authority = await resourceAuthority(tx, context);
        await requireResource(tx as unknown as Database, authority, "requirement", requirementId);
        const rows = await tx.select().from(activityLog).where(and(eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, requirementId), eq(activityLog.action, "agent_reassessment_recorded")));
        // Evidence references and free text can reveal outputs beyond the caller's authority.
        return rows.map(row => {
          const metadata = row.metadata as Record<string, unknown> | null;
          return { id: row.id, actorId: row.actorId, createdAt: row.createdAt,
            grantId: metadata?.grantId, planRevision: metadata?.planRevision,
            requestedDecision: metadata?.requestedDecision, disposition: metadata?.disposition,
            inputsAvailable: metadata?.inputsAvailable, uncertainExternalEffects: metadata?.uncertainExternalEffects };
        });
      });
    },
    async apply(db: Database, value: z.input<typeof reassessmentApplyInputSchema>) {
      const input = reassessmentApplyInputSchema.parse(value);
      return db.transaction(async tx => {
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "revalidate_evidence" });
        const authority = await resourceAuthority(tx, context);
        await requireResource(tx as unknown as Database, authority, "requirement", input.requirementId, "resource.write");
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId));
        const [decision] = await tx.select().from(activityLog).where(and(eq(activityLog.id, input.decisionId), eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, input.requirementId), eq(activityLog.action, "agent_reassessment_recorded"))).for("share");
        const metadata = decision?.metadata as Record<string, unknown> | null | undefined;
        const parsed = reassessmentDecisionInputSchema.safeParse({ grantId: metadata?.grantId, projectId: input.projectId, requirementId: input.requirementId, expectedRevision: metadata?.planRevision, decision: metadata?.requestedDecision, evidence: metadata?.evidence, rationale: metadata?.rationale, inputsAvailable: metadata?.inputsAvailable, uncertainExternalEffects: metadata?.uncertainExternalEffects });
        if (!requirement || !decision || decision.actorType !== "agent" || decision.actorId !== grant.agentId || metadata?.grantId !== grant.id || metadata?.disposition !== "accept" || !parsed.success || typeof metadata.evidenceFingerprint !== "string") throw new ConflictError("Decision provenance is missing or not accepted", requirement?.planRevision ?? 0);
        if (requirement.planRevision !== parsed.data.expectedRevision) throw new ConflictError("Plan changed; inspect the latest evidence", requirement.planRevision);
        if (!requirement.evidenceNeedsReview) throw new ConflictError("Evidence review is already current", requirement.planRevision);
        const outputs = await tx.select().from(workflowOutputs).where(eq(workflowOutputs.requirementId, input.requirementId)).for("share");
        const ids = new Set(parsed.data.evidence.map(item => item.outputId));
        if (ids.size === 0 || outputs.length !== ids.size || outputs.some(output => !ids.has(output.id) || output.availability !== "available") || evidenceFingerprint(outputs) !== metadata.evidenceFingerprint || reassessmentDisposition(grant, { projectId: input.projectId, requirementId: input.requirementId, agentId: grant.agentId, operation: "revalidate_evidence", expectedRevision: parsed.data.expectedRevision, decision: parsed.data.decision, evidence: parsed.data.evidence.map(item => ({ reference: item.outputId, rationale: item.rationale })), rationale: parsed.data.rationale, inputsAvailable: parsed.data.inputsAvailable, uncertainExternalEffects: parsed.data.uncertainExternalEffects }, requirement.planRevision, new Date()) !== "accept") throw new ConflictError("Evidence or authority changed; reassess or escalate", requirement.planRevision);
        await tx.update(requirements).set({ evidenceNeedsReview: false }).where(eq(requirements.id, input.requirementId));
        await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId, action: "agent_reassessment_applied", actorId: grant.agentId, actorType: "agent", metadata: { decisionId: decision.id, grantId: grant.id, planRevision: requirement.planRevision } });
        await emitDurable(tx as unknown as Database, { type: "requirement_updated", projectId: input.projectId, requirementId: input.requirementId });
        return { revalidated: true, decisionId: decision.id };
      });
    },
    async record(db: Database, value: z.input<typeof reassessmentDecisionInputSchema>) {
      const input = reassessmentDecisionInputSchema.parse(value);
      return db.transaction(async tx => {
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "revalidate_evidence" });
        // The grant helper locks the requirement before the grant, serializing plan changes and revocation.
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId));
        if (!requirement || requirement.planRevision !== input.expectedRevision)
          throw new ConflictError("Plan changed; inspect the latest evidence", requirement?.planRevision ?? 0);
        const ids = [...new Set(input.evidence.map(item => item.outputId))];
        const outputs = await tx.select().from(workflowOutputs).where(eq(workflowOutputs.requirementId, input.requirementId)).for("share");
        const inputsAvailable = input.inputsAvailable && ids.length > 0 && outputs.length === ids.length && outputs.every(output => ids.includes(output.id) && output.availability === "available");
        const disposition = reassessmentDisposition(grant, {
          projectId: input.projectId, requirementId: input.requirementId, agentId: grant.agentId,
          operation: "revalidate_evidence", expectedRevision: input.expectedRevision, decision: input.decision,
          evidence: input.evidence.map(item => ({ reference: item.outputId, rationale: item.rationale })),
          rationale: input.rationale, inputsAvailable, uncertainExternalEffects: input.uncertainExternalEffects,
        }, requirement.planRevision, new Date());
        if (disposition === "unauthorized") throw new AuthorizationError();
        if (disposition === "stale") throw new ConflictError("Plan changed; inspect the latest evidence", requirement.planRevision);
        // This increment records a decision but does not clear the review flag or grant execution authority.
        const [record] = await tx.insert(activityLog).values({ entityType: "requirement", entityId: input.requirementId,
          action: "agent_reassessment_recorded", actorId: grant.agentId, actorType: "agent",
          metadata: { grantId: grant.id, planRevision: input.expectedRevision, requestedDecision: input.decision,
            disposition, evidence: input.evidence, rationale: input.rationale, inputsAvailable,
            uncertainExternalEffects: input.uncertainExternalEffects, evidenceFingerprint: evidenceFingerprint(outputs) } }).returning();
        return { id: record!.id, disposition };
      });
    },
  };
}
