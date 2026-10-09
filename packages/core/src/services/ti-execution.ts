import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { tiAgentRuns, tasks, requirementClaims, executionDelegations, documentTaskLinks, documentRequirementLinks, requirementRepositories, taskRepositories, type Database } from '@task-weaver/db';
import { AuthorizationError, AuthenticationError, NotFoundError, ValidationError, type VerifiedRequestContext, type AuthorizationGrant, createTiAgentRunSchema, acquireTiAgentRunSchema, tiWorkerFenceSchema, tiHeartbeatSchema, tiProgressSchema, tiRetrySchema, completeTiAgentRunSchema } from '@task-weaver/contracts';
import { getLiveRequestAuthority } from './api-keys';
import { loadActivePrincipal, loadPrincipalGrants, intersectGrants, grantsAreCovered } from './auth-principals';
import { lockIdentityLifecycle } from './auth-security';
import { requireResource, requireScope, projectPredicate } from './resource-authorization';
import { requireRepository } from './repository-authorization';
import { claimRequirement } from './claims';
import * as implementation from './ti-agent';
import { reportTiUsage } from './agent-usage';
import { reportTiAgentUsageSchema } from '@task-weaver/contracts';
import { liveTiRunAuthority, assertTiTaskReady, tiRunAuthorizationSchema } from './ti-execution-authorization';
import { insertCapability, liveExecutionAuthority } from './execution-delegations';

const operations = new Set(['createRun', 'acquireRun', 'heartbeatRunLease', 'updateRunProgress', 'scheduleRunRetry', 'completeRun']);
export const isTiExecutionOperation = (name: string) => operations.has(name);
const safeText = (value: string) => value.replace(/(?:tw|twd|twb)_[0-9a-f]{64}/g, '[REDACTED]');
function redact(value: any): any {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).filter(([key]) => !['authorization', 'apiKeyRef', 'encryptedApiKey', 'baseUrl'].includes(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}

/** The supervisor context is private; service credentials never create TW authority. */
export function createTiExecutionService(context: VerifiedRequestContext) {
  const transaction = async <T>(db: Database, operation: (tx: Database) => Promise<T>) => db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    if (context.credential.kind === 'delegation') throw new AuthorizationError();
    await getLiveRequestAuthority(tx, context);
    return operation(tx as unknown as Database);
  });
  async function held(db: Database, id: string, input: { workerId?: string; leaseGeneration?: number }) {
    const live = await liveTiRunAuthority(db, id);
    if (context.credential.kind !== 'api_key' || context.actor.id !== live.binding.executorActorId || context.credential.id !== live.binding.executorCredentialId
      || input.workerId !== live.binding.workerId || input.leaseGeneration !== live.binding.leaseGeneration) throw new AuthorizationError();
    return live;
  }
  return {
    async invoke(db: Database, name: string, args: any[]) {
      return transaction(db, async tx => {
        const authority = await getLiveRequestAuthority(tx, context);
        const actor = { id: authority.actor.id, type: authority.actor.type };
        if (name === 'createRun') {
          const input = createTiAgentRunSchema.parse(args[0]);
          if (!input.taskId && input.scheduleRunId) {
            const scheduled = await tx.query.scheduleRuns.findFirst({ where: (row, { eq }) => eq(row.id, input.scheduleRunId!) });
            if (!scheduled?.generatedTaskId) throw new NotFoundError('Resource not found');
            input.taskId = scheduled.generatedTaskId;
          }
          if (!input.taskId) throw new ValidationError('A Ti run requires a task');
          await requireResource(tx, authority, 'task', input.taskId, 'execution.run');
          await requireResource(tx, authority, 'task', input.taskId, 'resource.write');
          const task = await tx.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
          if (!task || task.scope !== 'project' || !task.projectId || !task.requirementId) throw new AuthorizationError();
          await assertTiTaskReady(tx, task);
          const executor = await loadActivePrincipal(tx, input.assignedAgentId);
          if (executor.type !== 'agent' || input.assignedAgentType !== 'agent' || task.assignee !== executor.id || task.assigneeType !== 'agent') throw new AuthorizationError();
          const executorAuthority = { actor: executor, grants: await loadPrincipalGrants(tx, executor.id) };
          await requireResource(tx, executorAuthority, 'task', task.id, 'execution.run');
          await requireResource(tx, executorAuthority, 'task', task.id, 'resource.write');
          const ownerId = authority.actor.type === 'human' ? authority.actor.id : authority.actor.managedByActorId;
          requireScope(authority, { personalOwnerId: ownerId, personalOwnerType: 'human' }, 'resource.read');
          const ownerActor = { id: ownerId, type: 'human' as const };
          const policy = await implementation.getPolicy(tx, {}, ownerActor);
          if (!policy?.enabled || policy.executionMode === 'disabled') throw new AuthorizationError();
          const model = await implementation.resolveModel(tx, { target: 'agent', requestedProvider: input.requestedProvider, requestedModel: input.requestedModel }, ownerActor);
          if (!model.config) throw new AuthorizationError();
          // Only the model owner chooses provider configuration; the recorded initiator remains unchanged.
          const run = await implementation.createRun(tx, input, actor, ownerActor);
          const authorization = tiRunAuthorizationSchema.parse({ initiatorActorId: actor.id, initiatorCredentialId: context.credential.id, initiatorCredentialKind: context.credential.kind,
            initiatorGrants: authority.grants, modelConfigId: model.config.id, modelVersion: model.config.updatedAt.toISOString(), policyId: policy.id, policyVersion: policy.updatedAt.toISOString(), ownerId, executorActorId: executor.id, executorCredentialId: null, claimId: null, attemptExpiresAt: null, leaseGeneration: null, workerId: null });
          const [updated] = await tx.update(tiAgentRuns).set({ authorization, createdBy: actor.id }).where(eq(tiAgentRuns.id, run.id)).returning();
          return redact(updated);
        }
        if (name === 'acquireRun') {
          if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
          const input = acquireTiAgentRunSchema.parse(args[0]);
          if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key' || input.assignedAgentId !== authority.actor.id || !input.workerId || !Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 15) throw new AuthorizationError();
          const candidates = await tx.select({ run: tiAgentRuns }).from(tiAgentRuns).innerJoin(tasks, eq(tasks.id, tiAgentRuns.taskId)).where(and(
            sql`${tiAgentRuns.authorization} IS NOT NULL`, eq(tiAgentRuns.assignedAgentId, authority.actor.id), eq(tiAgentRuns.assignedAgentType, 'agent'),
            projectPredicate(authority, 'execution.run', tasks.projectId), projectPredicate(authority, 'resource.write', tasks.projectId),
            or(and(eq(tiAgentRuns.status, 'queued'), or(isNull(tiAgentRuns.nextAttemptAt), lte(tiAgentRuns.nextAttemptAt, new Date()))), and(inArray(tiAgentRuns.status, ['running', 'in_review']), lte(tiAgentRuns.leaseExpiresAt, new Date()))),
          )).orderBy(asc(tiAgentRuns.createdAt)).limit(100);
          for (const { run } of candidates) {
            let live;
            try { live = await liveTiRunAuthority(tx, run.id, false); await assertTiTaskReady(tx, live.task); } catch (error) {
              if (error instanceof AuthenticationError || error instanceof AuthorizationError || error instanceof ValidationError || error instanceof NotFoundError) continue;
              throw error;
            }
            const existing = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, live.task.requirementId!) });
            if (existing && existing.expiresAt > new Date()) continue;
            const running = await tx.select({ id: tiAgentRuns.id }).from(tiAgentRuns).where(and(eq(tiAgentRuns.assignedAgentId, actor.id), inArray(tiAgentRuns.status, ['running', 'in_review']), sql`${tiAgentRuns.leaseExpiresAt} > now()`));
            if (running.length >= live.policy.maxConcurrentRuns) return null;
            const [usage] = await tx.select({ daily: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, monthly: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')` }).from(tiAgentRuns).where(eq(tiAgentRuns.assignedAgentId, actor.id));
            if ((live.policy.dailyRunLimit > 0 && Number(usage?.daily) >= live.policy.dailyRunLimit) || (live.policy.monthlyRunLimit > 0 && Number(usage?.monthly) >= live.policy.monthlyRunLimit)) return null;
            const claim = await claimRequirement(tx, live.task.requirementId!, actor, input.durationMinutes, { workerIndex: `ti:${run.id}:${input.workerId}` });
            const authorization = { ...live.binding, executorCredentialId: context.credential.id, claimId: claim.id, attemptExpiresAt: new Date(Date.now() + live.policy.runTimeoutSeconds * 1_000).toISOString(), leaseGeneration: claim.generation, workerId: input.workerId };
            const deadline = new Date(Math.min(Date.parse(authorization.attemptExpiresAt), claim.expiresAt.getTime(), context.credential.expiresAt ? Date.parse(context.credential.expiresAt) : Infinity));
            const [updated] = await tx.update(tiAgentRuns).set({ authorization, status: 'running', leaseOwnerId: input.workerId, leaseOwnerType: 'agent', leaseExpiresAt: deadline, nextAttemptAt: null, startedAt: run.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(tiAgentRuns.id, run.id)).returning();
            return { ...redact(updated), leaseGeneration: claim.generation };
          }
          return null;
        }
        const [id, rawInput] = args;
        const schemas = { heartbeatRunLease: tiHeartbeatSchema, updateRunProgress: tiProgressSchema, scheduleRunRetry: tiRetrySchema, completeRun: completeTiAgentRunSchema };
        const schema = schemas[name as keyof typeof schemas];
        const input = redact(schema ? schema.parse(rawInput) : name === 'reportUsage' ? reportTiAgentUsageSchema.parse(rawInput) : tiWorkerFenceSchema.strict().parse(rawInput));
        const live = await held(tx, id, tiWorkerFenceSchema.parse(input));
        if (name === 'reportUsage') {
          const usage = reportTiAgentUsageSchema.parse(input);
          if (usage.attempt !== live.run.retryCount) throw new AuthorizationError();
          return reportTiUsage(tx, id, usage, actor, { runId: live.claim!.id, generation: live.claim!.generation, workerId: live.binding.workerId! });
        }
        if (name === 'assertRun') return { ...redact(live.run), leaseGeneration: live.binding.leaseGeneration };
        if (name === 'heartbeatRunLease') {
          if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 15) throw new ValidationError('Invalid Ti lease duration');
          const deadline = new Date(Math.min(Date.parse(live.binding.attemptExpiresAt!), Date.now() + input.durationMinutes * 60_000, context.credential.expiresAt ? Date.parse(context.credential.expiresAt) : Infinity));
          await tx.update(requirementClaims).set({ heartbeatAt: new Date(), expiresAt: deadline }).where(eq(requirementClaims.id, live.claim!.id));
          const [updated] = await tx.update(tiAgentRuns).set({ leaseExpiresAt: deadline, updatedAt: new Date() }).where(eq(tiAgentRuns.id, id)).returning();
          return { ...redact(updated), leaseGeneration: live.binding.leaseGeneration };
        }
        let result;
        if (name === 'updateRunProgress') result = await implementation.updateRunProgress(tx, id, input, actor);
        else if (name === 'scheduleRunRetry') result = await implementation.scheduleRunRetry(tx, id, input, actor);
        else if (name === 'completeRun') result = await implementation.completeRun(tx, id, input, actor);
        else throw new AuthorizationError();
        if (result && name !== 'updateRunProgress') {
          await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.tiRunId, id), isNull(executionDelegations.revokedAt)));
          await tx.delete(requirementClaims).where(eq(requirementClaims.id, live.claim!.id));
        }
        return redact(result);
      });
    },
    async issueDelegation(db: Database, id: string, input: { workerId: string; leaseGeneration: number }) {
      return transaction(db, async tx => {
        const live = await held(tx, id, tiWorkerFenceSchema.parse(input));
        await assertTiTaskReady(tx, live.task);
        const taskIds = [live.task.id];
        const links = await tx.select({ id: documentTaskLinks.documentId }).from(documentTaskLinks).where(eq(documentTaskLinks.taskId, live.task.id));
        const reqLinks = await tx.select({ id: documentRequirementLinks.documentId }).from(documentRequirementLinks).where(eq(documentRequirementLinks.requirementId, live.task.requirementId!));
        const documentIds = [...new Set([...links, ...reqLinks].map(row => row.id))];
        for (const documentId of documentIds) {
          const document = await requireResource(tx, live.executor!, 'document', documentId);
          await requireResource(tx, live.initiator, 'document', documentId);
          if (document.projectId !== live.task.projectId) throw new AuthorizationError();
        }
        const reqRepos = await tx.select({ id: requirementRepositories.repositoryId }).from(requirementRepositories).where(eq(requirementRepositories.requirementId, live.task.requirementId!));
        const taskRepos = await tx.select({ id: taskRepositories.repositoryId }).from(taskRepositories).where(eq(taskRepositories.taskId, live.task.id));
        const repositoryIds = [...new Set([...reqRepos, ...taskRepos].map(row => row.id))];
        for (const repositoryId of repositoryIds) { await requireRepository(tx, live.executor!, repositoryId); await requireRepository(tx, live.initiator, repositoryId); }
        const grants: AuthorizationGrant[] = [{ scope: 'project', projectId: live.task.projectId!, permissions: ['resource.read', 'resource.write', 'execution.run'] }];
        if (!grantsAreCovered(grants, intersectGrants(live.executor!.grants, live.initiator.grants))) throw new AuthorizationError();
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.tiRunId, id), isNull(executionDelegations.revokedAt)));
        return insertCapability(tx, { parentCredentialId: context.credential.id, actorId: live.binding.executorActorId, initiatorActorId: live.binding.initiatorActorId,
          projectId: live.task.projectId!, requirementId: live.task.requirementId!, tiRunId: id, daemonId: null, runId: live.claim!.id, workerIndex: live.claim!.workerIndex!, leaseGeneration: String(input.leaseGeneration),
          purpose: 'automation', taskIds, documentIds, sliceIds: live.task.executionSliceId ? [live.task.executionSliceId] : [], repositoryIds, grants }, live.run.leaseExpiresAt!);
      });
    },
    async renewDelegation(db: Database, id: string, delegationId: string, input: { workerId: string; leaseGeneration: number }) {
      return transaction(db, async tx => {
        const live = await held(tx, id, tiWorkerFenceSchema.parse(input));
        const original = await liveExecutionAuthority(tx, delegationId);
        if (original.row.tiRunId !== id || original.row.parentCredentialId !== context.credential.id) throw new AuthorizationError();
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(eq(executionDelegations.id, delegationId));
        const { id: _id, tokenHash: _hash, createdAt: _created, expiresAt: _expires, revokedAt: _revoked, ...bounds } = original.row;
        return insertCapability(tx, bounds, live.run.leaseExpiresAt!);
      });
    },
  };
}
