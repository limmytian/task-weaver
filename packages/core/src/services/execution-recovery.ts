import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { daemons, executionControls, executionDelegations, requirementClaims, requirementRepositories, requirements, tasks, taskClaims, type Database } from '@task-weaver/db';
import { ValidationError } from '@task-weaver/contracts';
import { recoveryDisposition } from './planning-impact-policy';

export async function recordExpiredExecution(db: Database, claim: typeof requirementClaims.$inferSelect) {
  if (!claim.daemonId) return;
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, claim.daemonId) });
  const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, claim.requirementId) });
  if (!daemon || !requirement) return;
  const affectedTasks = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.requirementId, requirement.id));
  await db.delete(taskClaims).where(and(inArray(taskClaims.taskId, affectedTasks), eq(taskClaims.claimedBy, claim.claimedBy), eq(taskClaims.claimedByType, 'agent')));
  await db.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.runId, claim.id), isNull(executionDelegations.revokedAt)));
  const links = await db.select().from(requirementRepositories).where(eq(requirementRepositories.requirementId, requirement.id));
  const uncertain = links.some(link => link.deliveryStatus === 'pushing' || Object.entries(link.operationCheckpoints ?? {}).some(([operation, checkpoint]) => ['push', 'merge', 'pull_request'].includes(operation) && checkpoint.status === 'in_progress'));
  const previous = await db.query.executionControls.findFirst({ where: eq(executionControls.runId, claim.id) });
  const lastObservedAt = Math.max(daemon.lastHeartbeatAt.getTime(), claim.heartbeatAt.getTime());
  const failureDeadline = new Date(lastObservedAt + requirement.recoveryPolicy.graceMs);
  const deadline = previous && previous.deadline < failureDeadline ? previous.deadline : failureDeadline;
  const workspace = { ...previous?.workspace, nodeId: daemon.nodeId, failure: true, uncertainEffects: uncertain || daemon.role !== 'executor', lastObservedAt: new Date(lastObservedAt).toISOString(), durableResults: links.filter(link => link.pushedCommit).map(link => ({ repositoryId: link.repositoryId, pushedCommit: link.pushedCommit })) };
  const reason = uncertain || daemon.role !== 'executor' ? 'Manual verification required: external operation outcome may be uncertain' : 'Node liveness lost; local progress may be unavailable';
  const phase = uncertain || daemon.role !== 'executor' ? 'manual' as const : previous?.phase ?? 'pending' as const;
  await db.insert(executionControls).values({ requirementId: requirement.id, projectId: requirement.projectId, daemonId: daemon.id, runId: claim.id, revision: requirement.planRevision,
    reason, phase, workspace, deadline,
  }).onConflictDoUpdate({ target: executionControls.runId, set: { reason, phase, workspace, deadline, updatedAt: new Date() } });
}

/** Invoked before new lane acquisition, under the acquisition transaction/identity lock. */
export async function enforceRecoveryAcquisition(db: Database, requirementId: string, daemonId?: string) {
  const control = await db.query.executionControls.findFirst({ where: eq(executionControls.requirementId, requirementId), orderBy: (control, { desc }) => [desc(control.createdAt)] });
  if (!control || control.phase === 'resumed') return;
  const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
  if (!requirement) return;
  const oldClaim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.id, control.runId) });
  const daemon = daemonId ? await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) }) : null;
  const original = await db.query.daemons.findFirst({ where: eq(daemons.id, control.daemonId) });
  const sameNode = Boolean(daemon?.nodeId && daemon.nodeId === (control.workspace?.nodeId ?? original?.nodeId));
  const localStopped = ['stopped', 'reconciling', 'blocked'].includes(control.phase);
  if (control.phase === 'manual') throw new ValidationError(control.reason);
  // Healthy dependency waiting has already observed local termination and releases capacity immediately.
  const healthyWait = control.phase === 'blocked' && !control.workspace?.failure;
  if (healthyWait && sameNode) {
    await db.update(executionControls).set({ phase: 'resumed', reason: 'Local dependency wait ended; reassess preserved work against the latest plan', updatedAt: new Date() }).where(eq(executionControls.id, control.id));
    return;
  }
  const now = Date.now();
  const disposition = recoveryDisposition({ now, lastObservedAt: control.deadline.getTime() - requirement.recoveryPolicy.graceMs,
    authorityExpiresAt: oldClaim?.expiresAt.getTime() ?? 0, revoked: true, sameNode, stopped: localStopped,
    attempts: requirement.recoveryAttempts, policy: requirement.recoveryPolicy, inputsAvailable: true,
    uncertainEffects: Boolean(control.workspace?.uncertainEffects),
  });
  if (disposition !== 'local_reassessment' && disposition !== 'restart_with_possible_local_loss') throw new ValidationError(`Execution recovery: ${disposition}; ${control.reason}`);
  if (disposition === 'restart_with_possible_local_loss') await db.update(requirements).set({ recoveryAttempts: sql`${requirements.recoveryAttempts} + 1` }).where(eq(requirements.id, requirementId));
  // Claim creation and this transition commit together; failed acquisition rolls back.
  await db.update(executionControls).set({ phase: 'resumed', reason: disposition, updatedAt: new Date() }).where(eq(executionControls.id, control.id));
}

/** Persist actionable scheduler reasons outside a failed nested acquisition savepoint. */
export async function recordRecoveryAcquisitionBlock(db: Database, requirementId: string, error: Error) {
  const state = /Execution recovery: ([a-z_]+)/.exec(error.message)?.[1];
  if (!state) return;
  const control = await db.query.executionControls.findFirst({ where: eq(executionControls.requirementId, requirementId), orderBy: (control, { desc }) => [desc(control.createdAt)] });
  if (!control || control.phase === 'manual') return;
  const reasons: Record<string, string> = {
    retry_exhausted: 'Automatic execution recovery budget exhausted; inspect prior attempts before authorizing more work',
    manual_retry_safety: 'Replay safety is unknown; verify external outcomes and durable inputs before authorizing recovery',
    manual_external_outcome: 'External operation outcome is uncertain; verify the provider state before repeating it',
    awaiting_node: `Waiting for the original node until ${control.deadline.toISOString()}; no replacement is authorized yet`,
    input_unavailable: 'Required input cannot be reconstructed; restore it or explicitly authorize recovery',
  };
  if (!reasons[state]) return;
  await db.update(executionControls).set({ reason: reasons[state], phase: state === 'awaiting_node' ? control.phase : 'manual', updatedAt: new Date() }).where(eq(executionControls.id, control.id));
}
