import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { tiAgentRuns, tiAgentPolicies, tiAgentModelConfigs, tasks, requirementClaims, requirements, taskDependencies, type Database } from '@task-weaver/db';
import { AuthenticationError, AuthorizationError, credentialGrantsSchema } from '@task-weaver/contracts';
import { getBoundCredentialAuthority } from './api-keys';
import { intersectGrants } from './auth-principals';
import { requireResource, requireScope } from './resource-authorization';
import { assertExecutionSliceCanAdvance } from './execution-slice-policy';

export const tiRunAuthorizationSchema = z.object({
  initiatorActorId: z.string().uuid(), initiatorCredentialId: z.string().uuid(),
  initiatorCredentialKind: z.enum(['session', 'api_key']), initiatorGrants: credentialGrantsSchema,
  modelConfigId: z.string().uuid(), modelVersion: z.string(), policyId: z.string().uuid(), policyVersion: z.string(),
  ownerId: z.string().uuid(), executorActorId: z.string().uuid(),
  executorCredentialId: z.string().uuid().nullable(), claimId: z.string().uuid().nullable(),
  attemptExpiresAt: z.string().datetime().nullable(), leaseGeneration: z.number().int().positive().nullable(), workerId: z.string().min(1).nullable(),
}).strict();

/** A retry preserves the initiator's ceiling; current assignment and policy remain mandatory. */
export async function liveTiRunAuthority(db: Database, runId: string, requireLease = true) {
  const run = await db.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, runId) });
  const parsed = tiRunAuthorizationSchema.safeParse(run?.authorization);
  if (!run || !parsed.success || !run.taskId || ['cancelled', 'succeeded', 'failed'].includes(run.status)) throw new AuthenticationError('invalid_credential');
  const binding = parsed.data;
  const initiator = await getBoundCredentialAuthority(db, { actorId: binding.initiatorActorId, credentialId: binding.initiatorCredentialId, credentialKind: binding.initiatorCredentialKind });
  const authority = { ...initiator, grants: intersectGrants(initiator.grants, binding.initiatorGrants) };
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, run.taskId) });
  if (!task || task.scope !== 'project' || !task.projectId || !task.requirementId || task.status === 'cancelled'
    || task.assignee !== binding.executorActorId || task.assigneeType !== 'agent' || run.assignedAgentId !== binding.executorActorId || run.assignedAgentType !== 'agent') throw new AuthenticationError('invalid_credential');
  await requireResource(db, authority, 'task', task.id, 'execution.run');
  await requireResource(db, authority, 'task', task.id, 'resource.write');
  requireScope(authority, { personalOwnerId: binding.ownerId, personalOwnerType: 'human' }, 'resource.read');
  const policy = await db.query.tiAgentPolicies.findFirst({ where: and(eq(tiAgentPolicies.ownerId, binding.ownerId), eq(tiAgentPolicies.ownerType, 'human')) });
  const model = await db.query.tiAgentModelConfigs.findFirst({ where: and(eq(tiAgentModelConfigs.ownerId, binding.ownerId), eq(tiAgentModelConfigs.ownerType, 'human'), eq(tiAgentModelConfigs.id, binding.modelConfigId)) });
  if (policy?.id !== binding.policyId || policy?.updatedAt.toISOString() !== binding.policyVersion || model?.updatedAt.toISOString() !== binding.modelVersion || !policy?.enabled || policy.executionMode === 'disabled' || !model?.enabled || ['invalid', 'missing'].includes(model.credentialStatus)) throw new AuthorizationError();
  if (run.scheduleRunId) {
    const scheduled = await db.query.scheduleRuns.findFirst({ where: (row, { eq }) => eq(row.id, run.scheduleRunId!) });
    const schedule = scheduled && await db.query.schedules.findFirst({ where: (row, { eq }) => eq(row.id, scheduled.scheduleId) });
    if (!schedule || schedule.targetScope !== 'project' || schedule.projectId !== task.projectId || schedule.requirementId !== task.requirementId || scheduled?.generatedTaskId !== task.id || schedule.status !== 'active') throw new AuthorizationError();
  }
  if (requireLease) {
    if (!binding.attemptExpiresAt || Date.parse(binding.attemptExpiresAt) <= Date.now() || !binding.executorCredentialId || !binding.claimId || !binding.leaseGeneration || !binding.workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= new Date() || !['running', 'in_review'].includes(run.status)) throw new AuthenticationError('invalid_credential');
    const executor = await getBoundCredentialAuthority(db, { actorId: binding.executorActorId, credentialId: binding.executorCredentialId, credentialKind: 'api_key' });
    await requireResource(db, executor, 'task', task.id, 'execution.run');
    await requireResource(db, executor, 'task', task.id, 'resource.write');
    const claim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.id, binding.claimId) });
    const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, task.requirementId) });
    if (!claim || claim.requirementId !== task.requirementId || claim.claimedBy !== binding.executorActorId || claim.claimedByType !== 'agent' || claim.daemonId !== null
      || claim.workerIndex !== `ti:${run.id}:${binding.workerId}` || claim.generation !== binding.leaseGeneration || claim.expiresAt <= new Date()
      || !requirement || requirement.projectId !== task.projectId || requirement.leaseGeneration !== binding.leaseGeneration || ['done', 'cancelled', 'archived'].includes(requirement.status)
      || run.leaseOwnerId !== binding.workerId || run.leaseOwnerType !== 'agent') throw new AuthenticationError('invalid_credential');
    return { run, binding, task, policy, model, initiator: authority, executor, claim };
  }
  return { run, binding, task, policy, model, initiator: authority, executor: null, claim: null };
}

export async function assertTiTaskReady(db: Database, task: typeof tasks.$inferSelect) {
  if (task.status === 'done' || task.status === 'cancelled') throw new AuthorizationError();
  if (task.executionSliceId) await assertExecutionSliceCanAdvance(db, task.executionSliceId);
  const blockers = await db.select({ status: tasks.status }).from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId)).where(and(eq(taskDependencies.taskId, task.id), eq(taskDependencies.type, 'blocks')));
  if (blockers.some(row => row.status !== 'done')) throw new AuthorizationError();
}
