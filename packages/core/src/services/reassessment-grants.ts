import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authActors, reassessmentGrants, requirements, type Database } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle, auditIdentity } from "./auth-security";
import { resourceAuthority, requireResource } from "./resource-authorization";

const inputSchema = z.object({ projectId: z.string().uuid(), requirementId: z.string().uuid().nullable(), agentId: z.string().uuid(), operations: z.array(z.literal("revalidate_evidence")).min(1).max(1), expiresAt: z.date() }).strict();
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function manager(tx: Transaction, context: VerifiedRequestContext, projectId: string) {
  const authority = await resourceAuthority(tx, context);
  if (authority.actor.type !== "human" || authority.bounds) throw new AuthorizationError();
  await requireResource(tx as unknown as Database, authority, "project", projectId, "project.manage");
  return authority.actor;
}

/** Human-managed preauthorization only; it neither creates a credential nor an execution lease. */
export function createReassessmentGrantService(context: VerifiedRequestContext) {
  return {
    async create(db: Database, value: z.input<typeof inputSchema>) {
      const input = inputSchema.parse(value);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const actor = await manager(tx, context, input.projectId);
        if (input.expiresAt <= new Date()) throw new ValidationError("Grant expiry must be in the future");
        if (input.requirementId) {
          const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId)).for("share");
          if (!requirement || requirement.projectId !== input.projectId) throw new ValidationError("Requirement must belong to the project");
        }
        const [agent] = await tx.select().from(authActors).where(eq(authActors.id, input.agentId)).for("share");
        if (!agent || agent.type !== "agent" || agent.status !== "active" || agent.deletedAt) throw new ValidationError("An active agent is required");
        const [grant] = await tx.insert(reassessmentGrants).values({ ...input, createdBy: actor.id }).returning();
        await auditIdentity(tx, "reassessment_grant.created", actor.id, agent.id, grant!.id, { projectId: input.projectId, requirementId: input.requirementId ?? "", operations: input.operations.join(","), expiresAt: input.expiresAt.toISOString() });
        return grant!;
      });
    },
    async list(db: Database, projectId: string) {
      z.string().uuid().parse(projectId);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        await manager(tx, context, projectId);
        return tx.select().from(reassessmentGrants).where(eq(reassessmentGrants.projectId, projectId));
      });
    },
    async revoke(db: Database, projectId: string, grantId: string) {
      z.string().uuid().parse(projectId); z.string().uuid().parse(grantId);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const actor = await manager(tx, context, projectId);
        const [grant] = await tx.select().from(reassessmentGrants).where(and(eq(reassessmentGrants.id, grantId), eq(reassessmentGrants.projectId, projectId))).for("update");
        if (!grant) throw new NotFoundError("Grant not found");
        if (grant.revokedAt) return grant;
        const [revoked] = await tx.update(reassessmentGrants).set({ revokedAt: new Date(), revokedBy: actor.id }).where(eq(reassessmentGrants.id, grantId)).returning();
        await auditIdentity(tx, "reassessment_grant.revoked", actor.id, grant.agentId, grant.id, { projectId });
        return revoked!;
      });
    },
  };
}

/** Hold the grant lock through the caller's transaction; never use this as an execution lease. */
export async function lockReassessmentGrant(tx: Transaction, context: VerifiedRequestContext, input: { grantId: string; projectId: string; requirementId: string; operation: "revalidate_evidence" }) {
  await lockIdentityLifecycle(tx);
  const authority = await resourceAuthority(tx, context);
  if (authority.actor.type !== "agent") throw new AuthorizationError();
  await requireResource(tx as unknown as Database, authority, "requirement", input.requirementId);
  const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId)).for("share");
  const [grant] = await tx.select().from(reassessmentGrants).where(eq(reassessmentGrants.id, input.grantId)).for("update");
  if (!requirement || requirement.projectId !== input.projectId || !grant || grant.projectId !== input.projectId ||
      (grant.requirementId !== null && grant.requirementId !== input.requirementId) || grant.agentId !== authority.actor.id ||
      grant.revokedAt || grant.expiresAt <= new Date() || !grant.operations.includes(input.operation)) throw new AuthorizationError();
  return grant;
}
