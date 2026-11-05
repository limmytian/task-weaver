import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
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
    async record(db: Database, value: z.input<typeof reassessmentDecisionInputSchema>) {
      const input = reassessmentDecisionInputSchema.parse(value);
      return db.transaction(async tx => {
        const grant = await lockReassessmentGrant(tx, context, { ...input, operation: "revalidate_evidence" });
        // The grant helper locks the requirement before the grant, serializing plan changes and revocation.
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId));
        if (!requirement || requirement.planRevision !== input.expectedRevision)
          throw new ConflictError("Plan changed; inspect the latest evidence", requirement?.planRevision ?? 0);
        const ids = [...new Set(input.evidence.map(item => item.outputId))];
        const outputs = ids.length ? await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.requirementId, input.requirementId), inArray(workflowOutputs.id, ids))).for("share") : [];
        const inputsAvailable = input.inputsAvailable && outputs.length === ids.length && outputs.every(output => output.availability === "available");
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
            uncertainExternalEffects: input.uncertainExternalEffects } }).returning();
        return { id: record!.id, disposition };
      });
    },
  };
}
