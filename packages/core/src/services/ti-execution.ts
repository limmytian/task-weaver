import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tiAgentRuns, tasks, taskStatusLog, projects, requirements, workerAttempts, requirementClaims, executionDelegations, documentTaskLinks, documentRequirementLinks, requirementRepositories, taskRepositories, tiSandboxWorkspaces, activityLog, type Database } from '@task-weaver/db';
import { AuthorizationError, AuthenticationError, NotFoundError, ValidationError, type VerifiedRequestContext, type AuthorizationGrant, createTiAgentRunSchema, acquireTiAgentRunSchema, tiWorkerFenceSchema, tiHeartbeatSchema, tiProgressSchema, tiRetrySchema, completeTiAgentRunSchema, cancelTiAgentRunSchema } from '@task-weaver/contracts';
import { getLiveRequestAuthority } from './api-keys';
import { loadActivePrincipal, loadPrincipalGrants, intersectGrants, grantsAreCovered } from './auth-principals';
import { lockIdentityLifecycle } from './auth-security';
import { requireResource, requireScope, projectPredicate } from './resource-authorization';
import { requireRepository } from './repository-authorization';
import * as implementation from './ti-agent';
import { reportTiUsage } from './agent-usage';
import { reportTiAgentUsageSchema } from '@task-weaver/contracts';
import { liveTiRunAuthority, assertTiTaskReady, tiRunAuthorizationSchema } from './ti-execution-authorization';
import { insertCapability, liveExecutionAuthority } from './execution-delegations';

const operations = new Set(['createRun', 'acquireRun', 'heartbeatRunLease', 'updateRunProgress', 'scheduleRunRetry', 'completeRun']);
export const isTiExecutionOperation = (name: string) => operations.has(name);
const safeText = (value: string) => value.replace(/(?:tw|twd|twb|twa)_[0-9a-f]{64}/g, '[REDACTED]');
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
        if (name === 'cancelRun') {
          const [id, raw] = args;
          const input = cancelTiAgentRunSchema.parse(raw ?? {});
          const run = await tx.query.tiAgentRuns.findFirst({ where: eq(tiAgentRuns.id, id) });
          if (!run?.taskId) throw new NotFoundError('Run not found');
          const scope = await requireResource(tx, authority, 'task', run.taskId, 'execution.run');
          await requireResource(tx, authority, 'task', run.taskId, 'resource.write');
          const binding = tiRunAuthorizationSchema.parse(run.authorization);
          if (actor.id !== binding.initiatorActorId && actor.id !== binding.ownerId) requireScope(authority, scope, 'project.manage');
          if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return redact(run);
          const now = new Date();
          const [cancelled] = await tx.update(tiAgentRuns).set({ status: 'cancelled', completedAt: now, updatedAt: now, leaseExpiresAt: now,
            errorMessage: safeText(input.reason ?? 'Cancelled by an authorized owner') }).where(eq(tiAgentRuns.id, id)).returning();
          await tx.update(executionDelegations).set({ revokedAt: now }).where(and(eq(executionDelegations.tiRunId, id), isNull(executionDelegations.revokedAt)));
          await tx.update(tiSandboxWorkspaces).set({ state: 'cleanup_pending', cancelRequestedAt: now, cleanupRequestedAt: now, nextCleanupAt: now, updatedAt: now })
            .where(and(eq(tiSandboxWorkspaces.runId, id), eq(tiSandboxWorkspaces.ownerId, binding.ownerId), sql`${tiSandboxWorkspaces.state} <> 'deleted'`));
          if (binding.claimId) await tx.delete(requirementClaims).where(and(eq(requirementClaims.id, binding.claimId), eq(requirementClaims.generation, binding.leaseGeneration ?? 0)));
          if (binding.attemptId) await tx.update(workerAttempts).set({ status: 'attention', completedAt: now, result: { outcome: 'attention', summary: 'Ti run cancelled; inspect the executor before resolving' } }).where(and(eq(workerAttempts.id, binding.attemptId), eq(workerAttempts.status, 'running')));
          await tx.insert(activityLog).values({ entityType: 'ti_agent_run', entityId: id, action: 'cancelled', actorId: actor.id, actorType: actor.type });
          return redact(cancelled);
        }
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
          // Serialize enqueue with ordinary worker acquisition in the same order.
          await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, task.projectId)).for('update');
          await tx.select({ id: requirements.id }).from(requirements).where(eq(requirements.id, task.requirementId)).for('update');
          const [lockedTask] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update');
          if (!lockedTask || lockedTask.projectId !== task.projectId || lockedTask.requirementId !== task.requirementId) throw new AuthorizationError();
          if (lockedTask.status === 'in_progress') throw new ValidationError('Task is already in progress');
          await assertTiTaskReady(tx, lockedTask);
          const [attempt] = await tx.select({ id: workerAttempts.id }).from(workerAttempts).where(and(eq(workerAttempts.taskId, task.id), inArray(workerAttempts.status, ['running', 'attention']))).limit(1);
          if (attempt) throw new ValidationError('Task has an unresolved worker attempt');
          const [activeRun] = await tx.select({ id: tiAgentRuns.id }).from(tiAgentRuns).where(and(eq(tiAgentRuns.taskId, task.id), inArray(tiAgentRuns.status, ['queued', 'running', 'in_review']))).limit(1);
          if (activeRun) throw new ValidationError('Task already has an active Ti run');
          const executor = await loadActivePrincipal(tx, input.assignedAgentId);
          if (executor.type !== 'agent' || input.assignedAgentType !== 'agent' || lockedTask.assignee !== executor.id || lockedTask.assigneeType !== 'agent') throw new AuthorizationError();
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
            initiatorGrants: authority.grants, modelConfigId: model.config.id, modelVersion: model.config.updatedAt.toISOString(), policyId: policy.id, policyVersion: policy.updatedAt.toISOString(), ownerId, executorActorId: executor.id, executorCredentialId: null, claimId: null, attemptId: null, attemptExpiresAt: null, leaseGeneration: null, workerId: null });
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
            and(eq(tiAgentRuns.status, 'queued'), or(isNull(tiAgentRuns.nextAttemptAt), lte(tiAgentRuns.nextAttemptAt, new Date()))),
          )).orderBy(asc(tiAgentRuns.createdAt)).limit(100);
          for (const { run } of candidates) {
            let live;
            try { live = await liveTiRunAuthority(tx, run.id, false); await assertTiTaskReady(tx, live.task); } catch (error) {
              if (error instanceof AuthenticationError || error instanceof AuthorizationError || error instanceof ValidationError || error instanceof NotFoundError) continue;
              throw error;
            }
            await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, live.task.projectId!)).for('update');
            const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, live.task.requirementId!)).for('update');
            const [task] = await tx.select().from(tasks).where(eq(tasks.id, live.task.id)).for('update');
            if (!requirement || !['approved', 'in_progress'].includes(requirement.status) || !task || task.projectId !== requirement.projectId || task.requirementId !== requirement.id || !['todo', 'in_review'].includes(task.status)) continue;
            await assertTiTaskReady(tx, task);
            const [blocked] = await tx.execute(sql`SELECT 1 AS blocked WHERE
              EXISTS (SELECT 1 FROM worker_attempts wa WHERE wa.task_id = ${task.id} AND wa.status IN ('running', 'attention')) OR
              EXISTS (SELECT 1 FROM task_claims tc WHERE tc.task_id = ${task.id}) OR
              EXISTS (SELECT 1 FROM requirement_claims rc WHERE rc.requirement_id = ${requirement.id}) OR
              EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements b ON b.id = d.depends_on_requirement_id WHERE d.requirement_id = ${requirement.id} AND d.type = 'blocks' AND b.status NOT IN ('done', 'cancelled')) OR
              EXISTS (SELECT 1 FROM execution_controls ec WHERE ec.id = (SELECT latest.id FROM execution_controls latest WHERE latest.requirement_id = ${requirement.id} ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AND ec.phase <> 'resumed')`) as unknown as Array<{ blocked: number }>;
            if (blocked) continue;
            await requireResource(tx, authority, 'task', task.id, 'execution.run');
            await requireResource(tx, authority, 'task', task.id, 'resource.write');
            // An expired or failed attempt still consumes capacity until its effects are inspected.
            const unresolved = await tx.select({ id: workerAttempts.id }).from(workerAttempts).where(and(eq(workerAttempts.actorId, actor.id), inArray(workerAttempts.status, ['running', 'attention']), sql`${workerAttempts.nodeId} LIKE 'ti:%'`));
            if (unresolved.length >= live.policy.maxConcurrentRuns) return null;
            const [usage] = await tx.select({ daily: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, monthly: sql<number>`count(*) FILTER (WHERE ${tiAgentRuns.startedAt} >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')` }).from(tiAgentRuns).where(eq(tiAgentRuns.assignedAgentId, actor.id));
            if ((live.policy.dailyRunLimit > 0 && Number(usage?.daily) >= live.policy.dailyRunLimit) || (live.policy.monthlyRunLimit > 0 && Number(usage?.monthly) >= live.policy.monthlyRunLimit)) return null;
            const generation = (live.binding.leaseGeneration ?? 0) + 1;
            const attemptExpiresAt = new Date(Date.now() + live.policy.runTimeoutSeconds * 1_000).toISOString();
            const deadline = new Date(Math.min(Date.parse(attemptExpiresAt), Date.now() + input.durationMinutes * 60_000, context.credential.expiresAt ? Date.parse(context.credential.expiresAt) : Infinity));
            const [attempt] = await tx.insert(workerAttempts).values({ projectId: task.projectId!, requirementId: requirement.id, taskId: task.id, actorId: actor.id, credentialId: context.credential.id, workerId: randomUUID(), nodeId: `ti:${run.id}:${input.workerId}`, tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'), planRevision: requirement.planRevision, expiresAt: deadline }).returning();
            if (task.status !== 'in_progress') {
              await tx.update(tasks).set({ status: 'in_progress', version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, task.id));
              await tx.insert(taskStatusLog).values({ taskId: task.id, fromStatus: task.status, toStatus: 'in_progress', changedBy: actor.id, changedByType: actor.type, reason: 'Acquired by Ti worker' });
            }
            const authorization = { ...live.binding, executorCredentialId: context.credential.id, claimId: null, attemptId: attempt!.id, attemptExpiresAt, leaseGeneration: generation, workerId: input.workerId };
            const [updated] = await tx.update(tiAgentRuns).set({ authorization, status: 'running', leaseOwnerId: input.workerId, leaseOwnerType: 'agent', leaseExpiresAt: deadline, nextAttemptAt: null, startedAt: run.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(tiAgentRuns.id, run.id)).returning();
            return { ...redact(updated), leaseGeneration: generation };
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
          return reportTiUsage(tx, id, usage, actor, { runId: live.attempt!.id, generation: live.binding.leaseGeneration!, workerId: live.binding.workerId! });
        }
        if (name === 'assertRun') return { ...redact(live.run), leaseGeneration: live.binding.leaseGeneration };
        if (name === 'heartbeatRunLease') {
          if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 15) throw new ValidationError('Invalid Ti lease duration');
          const deadline = new Date(Math.min(Date.parse(live.binding.attemptExpiresAt!), Date.now() + input.durationMinutes * 60_000, context.credential.expiresAt ? Date.parse(context.credential.expiresAt) : Infinity));
          await tx.update(workerAttempts).set({ heartbeatAt: new Date(), expiresAt: deadline }).where(and(eq(workerAttempts.id, live.attempt!.id), eq(workerAttempts.status, 'running')));
          const [updated] = await tx.update(tiAgentRuns).set({ leaseExpiresAt: deadline, updatedAt: new Date() }).where(eq(tiAgentRuns.id, id)).returning();
          return { ...redact(updated), leaseGeneration: live.binding.leaseGeneration };
        }
        let result;
        if (name === 'updateRunProgress') result = await implementation.updateRunProgress(tx, id, input, actor);
        else if (name === 'scheduleRunRetry') throw new ValidationError('Automatic Ti retry is unavailable; inspect and resolve the attempt before retrying');
        else if (name === 'completeRun') result = await implementation.completeRun(tx, id, input, actor);
        else throw new AuthorizationError();
        if (result && name !== 'updateRunProgress') {
          await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.tiRunId, id), isNull(executionDelegations.revokedAt)));
          await tx.update(workerAttempts).set({ status: input.status === 'succeeded' ? 'completed' : 'attention', completedAt: new Date(), result: { outcome: input.status, summary: input.errorMessage ?? input.outputSummary ?? '' } }).where(and(eq(workerAttempts.id, live.attempt!.id), eq(workerAttempts.status, 'running')));
          if (name === 'completeRun' && input.status === 'succeeded' && live.task.status === 'in_progress') {
            await tx.update(tasks).set({ status: 'in_review', version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, live.task.id));
            await tx.insert(taskStatusLog).values({ taskId: live.task.id, fromStatus: 'in_progress', toStatus: 'in_review', changedBy: actor.id, changedByType: actor.type, reason: 'Ti execution completed' });
          }
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
        const ceiling = intersectGrants(live.executor!.grants, live.initiator.grants);
        const mcpGrant: AuthorizationGrant = { scope: 'project', projectId: live.task.projectId!, permissions: ['mcp.invoke'] };
        const grants: AuthorizationGrant[] = [{ scope: 'project', projectId: live.task.projectId!,
          permissions: ['resource.read', 'resource.write', 'execution.run', ...(grantsAreCovered([mcpGrant], ceiling) ? ['mcp.invoke' as const] : [])] }];
        if (!grantsAreCovered(grants, intersectGrants(live.executor!.grants, live.initiator.grants))) throw new AuthorizationError();
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.tiRunId, id), isNull(executionDelegations.revokedAt)));
        return insertCapability(tx, { parentCredentialId: context.credential.id, actorId: live.binding.executorActorId, initiatorActorId: live.binding.initiatorActorId,
          projectId: live.task.projectId!, requirementId: live.task.requirementId!, tiRunId: id, daemonId: null, runId: live.attempt!.id, workerIndex: `ti:${id}:${live.binding.workerId}`, leaseGeneration: String(input.leaseGeneration),
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
