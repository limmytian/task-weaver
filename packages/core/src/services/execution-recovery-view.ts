import { desc, eq } from 'drizzle-orm';
import { executionControls, requirementClaims, requirements, type Database } from '@task-weaver/db';
import { AuthorizationError, NotFoundError, executionRecoveryViewSchema, type ExecutionRecoveryView, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { requireResource, resourceAuthority } from './resource-authorization';

type Control = typeof executionControls.$inferSelect;
type Requirement = Pick<typeof requirements.$inferSelect, 'status' | 'planRevision' | 'evidenceNeedsReview' | 'recoveryAttempts' | 'recoveryPolicy'>;
type Claim = Pick<typeof requirementClaims.$inferSelect, 'id' | 'expiresAt'>;

/** Observations only: no synthesized phase history or inferred node capacity. */
export function projectExecutionRecoveryView(requirement: Requirement, controls: Control[], claim: Claim | undefined,
  permissions: { human: boolean; write: boolean; manage: boolean }, now = new Date()): ExecutionRecoveryView {
  const latest = controls[0];
  const closed = ['done', 'cancelled', 'archived'].includes(requirement.status);
  const held = claim && claim.expiresAt > now;
  const revalidationBlock = !permissions.human ? 'human_required' : !permissions.write ? 'write_permission_required' : !requirement.evidenceNeedsReview ? 'evidence_current' : null;
  const recoveryBlock = !permissions.human ? 'human_required' : !permissions.manage ? 'management_permission_required' : closed ? 'requirement_closed' : !latest ? 'no_control' : latest.phase === 'resumed' ? 'already_decided' : claim && claim.id !== latest.runId ? 'replacement_owns_lane' : null;
  return executionRecoveryViewSchema.parse({
    observedAt: now.toISOString(), planRevision: requirement.planRevision, evidenceNeedsReview: requirement.evidenceNeedsReview,
    lane: { state: held ? 'held' : 'not_held', runId: held ? claim.id : null, expiresAt: held ? claim.expiresAt.toISOString() : null, executionAuthority: 'not_established', fleetCapacity: null, daemonHealth: 'not_observed' },
    retry: { used: requirement.recoveryAttempts, maximum: requirement.recoveryPolicy.maxAttempts, remaining: Math.max(0, requirement.recoveryPolicy.maxAttempts - requirement.recoveryAttempts), automaticRetrySafe: requirement.recoveryPolicy.retrySafe },
    controls: controls.slice(0, 10).map(control => ({
      id: control.id, runId: control.runId, daemonId: control.daemonId, revision: control.revision, phase: control.phase,
      reason: control.reason, deadline: control.deadline.toISOString(), deadlinePassed: control.deadline <= now,
      nodeId: typeof control.workspace?.nodeId === 'string' ? control.workspace.nodeId.slice(0, 255) : null,
      preservedState: typeof control.workspace?.state === 'string' ? control.workspace.state.slice(0, 100) : null,
      stopObservation: ['stopped', 'reconciling'].includes(control.phase) ? 'reported_in_current_phase' : 'not_established',
      observations: [{ kind: 'created', at: control.createdAt.toISOString() }, { kind: 'latest_phase', at: control.updatedAt.toISOString() }],
      updatedAt: control.updatedAt.toISOString(),
    })),
    actions: { revalidate: { allowed: revalidationBlock === null, blockedReason: revalidationBlock }, recover: { allowed: recoveryBlock === null, blockedReason: recoveryBlock, controlId: latest?.id ?? null, expectedControlUpdatedAt: latest?.updatedAt.toISOString() ?? null } },
  });
}

export function createExecutionRecoveryViewService(context: VerifiedRequestContext) {
  return {
    async get(db: Database, requirementId: string) {
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        await requireResource(tx, authority, 'requirement', requirementId, 'resource.read');
        const requirement = await tx.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
        if (!requirement) throw new NotFoundError('Requirement not found');
        const controls = await tx.select().from(executionControls).where(eq(executionControls.requirementId, requirementId)).orderBy(desc(executionControls.createdAt), desc(executionControls.id)).limit(10);
        const claim = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirementId) });
        const human = authority.actor.type === 'human' && !authority.bounds;
        const allowed = async (permission: 'resource.write' | 'project.manage') => {
          if (!human) return false;
          try { await requireResource(tx, authority, 'requirement', requirementId, permission); return true; }
          catch (error) { if (error instanceof AuthorizationError || error instanceof NotFoundError) return false; throw error; }
        };
        return projectExecutionRecoveryView(requirement, controls, claim, { human, write: await allowed('resource.write'), manage: await allowed('project.manage') });
      });
    },
  };
}
