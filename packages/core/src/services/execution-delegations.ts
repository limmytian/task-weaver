import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { daemons, documents, documentTaskLinks, documentRequirementLinks, executionDelegations, requirementClaims, requirements, tasks, taskDependencies, requirementRepositories, taskRepositories, type Database } from '@task-weaver/db';
import { AuthenticationError, AuthorizationError, NotFoundError, ValidationError, executionDelegationSchema, issueExecutionDelegationSchema, credentialGrantsSchema, requestIdentitySnapshotSchema, type Principal, type AuthorizationGrant, type AuthorizationPermission, type ExecutionDelegation, type IssueExecutionDelegationInput, type VerifiedRequestContext } from '@task-weaver/contracts';
import { getBoundCredentialAuthority, getLiveRequestAuthority } from './api-keys';
import { grantsAreCovered, intersectGrants, loadActivePrincipal, type AuthDatabase } from './auth-principals';
import { auditIdentity, lockIdentityLifecycle } from './auth-security';
import { requireRepository } from './repository-authorization';
import { requireResource } from './resource-authorization';

type StoredDelegation = typeof executionDelegations.$inferSelect;
export type ExecutionBounds = Pick<StoredDelegation, 'leaseGeneration' | 'expiresAt' | 'id' | 'projectId' | 'requirementId' | 'taskIds' | 'documentIds' | 'sliceIds' | 'repositoryIds' | 'daemonId' | 'runId' | 'purpose' | 'parentCredentialId'>;
const idSchema = z.string().uuid();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const phasePermission = (purpose: ExecutionDelegation['purpose']): AuthorizationPermission => purpose === 'review' ? 'execution.review' : purpose === 'merge' ? 'execution.merge' : 'execution.run';
function publicDelegation(row: StoredDelegation, initiatorType: 'human' | 'agent') {
  return executionDelegationSchema.parse({
    id: row.id, parentCredentialId: row.parentCredentialId, delegatorActorId: row.actorId,
    initiator: { id: row.initiatorActorId, type: initiatorType }, executorActorId: row.actorId,
    projectId: row.projectId, requirementId: row.requirementId, taskIds: row.taskIds,
    repositoryIds: row.repositoryIds, runId: row.runId, purpose: row.purpose,
    leaseGeneration: Number(row.leaseGeneration), expiresAt: row.expiresAt.toISOString(),
  });
}

/** Every delegated operation rechecks its immutable bounds, parent and original live lease. */
export async function liveExecutionAuthority(db: AuthDatabase, id: string, now = new Date()): Promise<{ actor: Principal; grants: AuthorizationGrant[]; bounds: ExecutionBounds; row: StoredDelegation }> {
  const database = db as Database;
  const row = await database.query.executionDelegations.findFirst({ where: eq(executionDelegations.id, id) });
  if (!row) throw new AuthenticationError('invalid_credential');
  if (row.revokedAt) throw new AuthenticationError('credential_revoked');
  if (row.expiresAt <= now) throw new AuthenticationError('credential_expired');
  const parent = await getBoundCredentialAuthority(db, { actorId: row.actorId, credentialId: row.parentCredentialId, credentialKind: 'api_key' });
  if (parent.actor.type !== 'agent') throw new AuthenticationError('invalid_credential');
  await loadActivePrincipal(db, row.initiatorActorId);
  const daemon = await database.query.daemons.findFirst({ where: eq(daemons.id, row.daemonId) });
  const lease = await database.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, row.requirementId) });
  const requirement = await database.query.requirements.findFirst({ where: eq(requirements.id, row.requirementId) });
  const expectedRole = row.purpose === 'review' ? 'reviewer' : row.purpose === 'merge' ? 'merger' : 'executor';
  if (!daemon || daemon.actorId !== row.actorId || daemon.actorType !== 'agent' || daemon.role !== expectedRole
    || !lease || lease.id !== row.runId || lease.claimedBy !== row.actorId || lease.claimedByType !== 'agent'
    || lease.daemonId !== row.daemonId || lease.workerIndex !== row.workerIndex || lease.generation !== Number(row.leaseGeneration)
    || lease.expiresAt <= now || !requirement || requirement.projectId !== row.projectId || requirement.leaseGeneration !== Number(row.leaseGeneration)
    || ['cancelled', 'done', 'archived'].includes(requirement.status)) throw new AuthenticationError('invalid_credential');
  if (!grantsAreCovered(credentialGrantsSchema.parse(row.grants), parent.grants)) throw new AuthorizationError();
  const authority = { ...parent, bounds: null };
  for (const taskId of row.taskIds) {
    const task = await database.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task || task.scope !== 'project' || task.requirementId !== row.requirementId || task.projectId !== row.projectId
      || task.status === 'cancelled' || (row.purpose === 'execute' && task.status === 'done')) throw new AuthenticationError('invalid_credential');
    await requireResource(database, authority, 'task', taskId, phasePermission(row.purpose));
  }
  for (const documentId of row.documentIds) {
    const document = await database.query.documents.findFirst({ where: eq(documents.id, documentId) });
    const taskLinks = await database.select({ id: documentTaskLinks.id }).from(documentTaskLinks).where(and(eq(documentTaskLinks.documentId, documentId), inArray(documentTaskLinks.taskId, row.taskIds))).limit(1);
    const requirementLinks = await database.select({ id: documentRequirementLinks.id }).from(documentRequirementLinks).where(and(eq(documentRequirementLinks.documentId, documentId), eq(documentRequirementLinks.requirementId, row.requirementId))).limit(1);
    if (!document || document.projectId !== row.projectId || (!taskLinks.length && !requirementLinks.length)) throw new AuthenticationError('invalid_credential');
    await requireResource(database, authority, 'document', documentId);
  }
  const currentRequirementRepositories = await database.select({ id: requirementRepositories.repositoryId }).from(requirementRepositories).where(eq(requirementRepositories.requirementId, row.requirementId));
  const currentTaskRepositories = await database.select({ id: taskRepositories.repositoryId }).from(taskRepositories).where(inArray(taskRepositories.taskId, row.taskIds));
  const currentRepositories = [...new Set([...currentRequirementRepositories, ...currentTaskRepositories].map(link => link.id))].sort();
  if (JSON.stringify(currentRepositories) !== JSON.stringify([...row.repositoryIds].sort())) throw new AuthenticationError('invalid_credential');
  for (const repositoryId of row.repositoryIds) await requireRepository(database, authority, repositoryId);
  return { actor: parent.actor, grants: intersectGrants(credentialGrantsSchema.parse(row.grants), parent.grants), bounds: row as ExecutionBounds, row };
}

export async function authenticateExecutionDelegation(db: AuthDatabase, token: string): Promise<VerifiedRequestContext> {
  if (!/^twd_[0-9a-f]{64}$/.test(token)) throw new AuthenticationError('invalid_credential');
  const [row] = await db.select().from(executionDelegations).where(eq(executionDelegations.tokenHash, digest(token))).limit(1);
  if (!row) throw new AuthenticationError('invalid_credential');
  const authority = await liveExecutionAuthority(db, row.id);
  const initiator = await loadActivePrincipal(db, row.initiatorActorId);
  return requestIdentitySnapshotSchema.parse({ actor: authority.actor, credential: {
    kind: 'delegation', id: row.id, actorId: row.actorId, expiresAt: row.expiresAt.toISOString(), grants: authority.grants,
    delegation: publicDelegation(row, initiator.type),
  }, verifiedAt: new Date().toISOString() }) as VerifiedRequestContext;
}

async function insertCapability(db: Database, bounds: Omit<typeof executionDelegations.$inferInsert, 'id' | 'tokenHash' | 'createdAt' | 'expiresAt'>, deadline: Date) {
  const now = new Date();
  const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000, deadline.getTime()));
  if (expiresAt <= now) throw new AuthenticationError('credential_expired');
  const token = `twd_${randomBytes(32).toString('hex')}`;
  const [created] = await db.insert(executionDelegations).values({ ...bounds, tokenHash: digest(token), createdAt: now, expiresAt }).returning();
  await auditIdentity(db, 'delegation.issued', bounds.actorId!, bounds.actorId!, created!.id);
  const initiator = await loadActivePrincipal(db, created!.initiatorActorId);
  return { delegation: publicDelegation(created!, initiator.type), token };
}

export function createExecutionDelegationService(context: VerifiedRequestContext) {
  return {
    async issue(db: Database, daemonId: string, input: IssueExecutionDelegationInput) {
      daemonId = idSchema.parse(daemonId);
      input = issueExecutionDelegationSchema.parse(input);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await getLiveRequestAuthority(tx, context);
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const daemon = await tx.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
        const claim = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, input.requirementId) });
        if (!daemon || daemon.actorId !== authority.actor.id || daemon.actorType !== 'agent') throw new NotFoundError('Daemon not found');
        if (!claim || claim.id !== input.runId || claim.daemonId !== daemonId || claim.claimedBy !== authority.actor.id || claim.claimedByType !== 'agent'
          || claim.generation !== input.leaseGeneration || claim.workerIndex !== String(input.workerIndex) || claim.expiresAt <= new Date()) throw new ValidationError('Delegation requires the original active worker lease');
        const purpose = daemon.role === 'reviewer' ? 'review' : daemon.role === 'merger' ? 'merge' : 'execute';
        if (purpose === 'execute' && !input.taskId) throw new ValidationError('Execution delegation requires the current task');
        const scope = await requireResource(tx, authority, 'requirement', input.requirementId, phasePermission(purpose));
        const requirement = await tx.query.requirements.findFirst({ where: eq(requirements.id, input.requirementId) });
        if (!requirement || requirement.leaseGeneration !== claim.generation || ['cancelled', 'done', 'archived'].includes(requirement.status)) throw new AuthorizationError();
        const selected = await tx.select().from(tasks).where(and(eq(tasks.requirementId, input.requirementId), purpose === 'execute' ? eq(tasks.id, input.taskId ?? '') : undefined));
        if (!selected.length || selected.some(task => task.scope !== 'project' || task.projectId !== scope.projectId || task.status === 'cancelled' || (purpose === 'execute' && task.status === 'done'))) throw new AuthorizationError();
        if (purpose === 'execute') {
          const blockers = await tx.select({ id: taskDependencies.dependsOnTaskId }).from(taskDependencies).where(and(eq(taskDependencies.taskId, input.taskId!), eq(taskDependencies.type, 'blocks')));
          for (const blocker of blockers) {
            await requireResource(tx, authority, 'task', blocker.id);
            const target = await tx.query.tasks.findFirst({ where: eq(tasks.id, blocker.id) });
            if (!target || !['done', 'cancelled'].includes(target.status)) throw new AuthorizationError();
          }
        }
        const taskIds = selected.map(task => task.id);
        for (const taskId of taskIds) await requireResource(tx, authority, 'task', taskId, phasePermission(purpose));
        const docLinks = await tx.select({ id: documentTaskLinks.documentId }).from(documentTaskLinks).where(inArray(documentTaskLinks.taskId, taskIds));
        const reqLinks = await tx.select({ id: documentRequirementLinks.documentId }).from(documentRequirementLinks).where(eq(documentRequirementLinks.requirementId, input.requirementId));
        const documentIds = [...new Set([...docLinks, ...reqLinks].map(link => link.id))];
        for (const id of documentIds) { const document = await requireResource(tx, authority, 'document', id); if (document.projectId !== scope.projectId) throw new AuthorizationError(); }
        const repositories = await tx.select({ id: requirementRepositories.repositoryId }).from(requirementRepositories).where(eq(requirementRepositories.requirementId, input.requirementId));
        const taskRepos = await tx.select({ id: taskRepositories.repositoryId }).from(taskRepositories).where(inArray(taskRepositories.taskId, taskIds));
        const repositoryIds = [...new Set([...repositories, ...taskRepos].map(link => link.id))];
        for (const id of repositoryIds) await requireRepository(tx, authority, id);
        const permissions: AuthorizationPermission[] = ['resource.read', phasePermission(purpose), ...(purpose === 'execute' ? ['resource.write' as const] : [])];
        const grants: AuthorizationGrant[] = [{ scope: 'project', projectId: scope.projectId!, permissions }];
        if (!grantsAreCovered(grants, authority.grants)) throw new AuthorizationError();
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.runId, claim.id), eq(executionDelegations.purpose, purpose), isNull(executionDelegations.revokedAt)));
        const deadline = context.credential.expiresAt ? new Date(Math.min(new Date(context.credential.expiresAt).getTime(), claim.expiresAt.getTime())) : claim.expiresAt;
        return insertCapability(tx, { parentCredentialId: context.credential.id, actorId: authority.actor.id, initiatorActorId: authority.actor.id,
          projectId: scope.projectId!, requirementId: input.requirementId, daemonId, runId: claim.id, workerIndex: String(input.workerIndex), leaseGeneration: String(claim.generation),
          purpose, taskIds, documentIds, sliceIds: [...new Set(selected.flatMap(task => task.executionSliceId ? [task.executionSliceId] : []))], repositoryIds, grants,
        }, deadline);
      });
    },
    async renew(db: Database, daemonId: string, id: string) {
      daemonId = idSchema.parse(daemonId); id = idSchema.parse(id);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await getLiveRequestAuthority(tx, context);
        const live = await liveExecutionAuthority(tx, id);
        if (context.credential.kind !== 'api_key' || authority.actor.id !== live.row.actorId || context.credential.id !== live.row.parentCredentialId || daemonId !== live.row.daemonId) throw new AuthorizationError();
        const claim = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.id, live.row.runId) });
        if (!claim) throw new AuthenticationError('invalid_credential');
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(eq(executionDelegations.id, id));
        const { id: _id, tokenHash: _hash, createdAt: _createdAt, expiresAt: _expiresAt, revokedAt: _revokedAt, ...bounds } = live.row;
        const deadline = context.credential.expiresAt ? new Date(Math.min(new Date(context.credential.expiresAt).getTime(), claim.expiresAt.getTime())) : claim.expiresAt;
        return insertCapability(tx, bounds, deadline);
      });
    },
    async revoke(db: Database, daemonId: string, id: string) {
      daemonId = idSchema.parse(daemonId); id = idSchema.parse(id);
      return db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const authority = await getLiveRequestAuthority(tx, context);
        const [row] = await tx.select().from(executionDelegations).where(eq(executionDelegations.id, id));
        if (!row || row.actorId !== authority.actor.id || row.daemonId !== daemonId || context.credential.kind !== 'api_key') throw new NotFoundError('Delegation not found');
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(eq(executionDelegations.id, id));
        await auditIdentity(tx, 'delegation.revoked', authority.actor.id, row.actorId, row.id);
        return { revoked: true };
      });
    },
  };
}
