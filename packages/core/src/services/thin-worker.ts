import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { activityLog, documentFileVersions, documents, executionControls, planDrafts, projects, requirementClaims, requirementRepositories, repositories, requirements, taskClaims, taskDependencies, taskStatusLog, tasks, thinGitDeliveries, thinWorkers, workerAttempts, workerPlanReceipts, workflowOutputs, type Database } from '@task-weaver/db';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError, redactObservabilityText, workerModeSchema, workerAcquireSchema, workerFenceSchema, workerGitPrepareSchema, workerGitTransitionSchema, workerGitConfirmSchema, workerGitAbandonPreparedSchema, workerGitReconcileSchema, workerHeartbeatSchema, workerOutputSchema, workerPlanSchema, workerPresenceSchema, workerResolveSchema, workerResultSchema, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { resourceAuthority, requireResource } from './resource-authorization';
import { attachmentStorage } from './attachment-storage';
import { emit } from '@task-weaver/realtime';
import { createResourceServices } from './resource-services';
import { createPlanDraft, validatePlanDraft, applyPlanDraft } from './plans';
import { advanceGitDelivery } from './thin-git-delivery-policy';
import { repositoryPredicate } from './repository-authorization';
import { gitRepositoryIdentity, readTrustedDirectMerge, verifyTrustedGitAncestry } from './trusted-forge';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const safeText = (value: string, limit: number) => redactObservabilityText(value, limit).value.replace(/\b(?:tw|twd|twb|twa)_[0-9a-f]{64}\b/gi, '[redacted]');
const publicAttempt = ({ tokenHash: _tokenHash, credentialId: _credentialId, ...attempt }: typeof workerAttempts.$inferSelect) => attempt;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The credential is held by the worker; executors never receive it. */
export function createThinWorkerService(context: VerifiedRequestContext, options: { forgeFetch?: typeof fetch } = {}) {
  const transact = async <T>(db: Database, run: (tx: Database, authority: Awaited<ReturnType<typeof resourceAuthority>>) => Promise<T>) => db.transaction(async transaction => {
    await lockIdentityLifecycle(transaction);
    const tx = transaction as unknown as Database;
    const authority = await resourceAuthority(tx, context);
    if (authority.bounds) throw new AuthorizationError();
    return run(tx, authority);
  });
  const lockProject = async (tx: Database, id: string) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
    if (!project || project.status !== 'active') throw new NotFoundError('Project not found');
    return project;
  };
  const acceptanceInputs = async (tx: Database, authority: Awaited<ReturnType<typeof resourceAuthority>>, taskId: string, revision: number) => {
    const dependencies = await tx.select().from(taskDependencies).where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.type, 'blocks')));
    if (!dependencies.length || dependencies.length > 100) throw new ValidationError('Acceptance requires bounded blocking dependencies');
    const inputs: Array<{ taskId: string; outputId: string; documentId: string; fileVersion: number; sha256: string; sizeBytes: number; mimeType: string; originalFilename: string; kind: 'worker' | 'human'; attemptId: string | null; gitDeliveries: Array<{ repositoryId: string; commit: string }> }> = [];
    for (const dependency of dependencies) {
      await requireResource(tx, authority, 'task', dependency.dependsOnTaskId);
      const [blocker] = await tx.select().from(tasks).where(eq(tasks.id, dependency.dependsOnTaskId)).for('share');
      if (!blocker || blocker.status !== 'done') throw new ConflictError('Acceptance dependency is incomplete', revision);
      const [completed] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.taskId, blocker.id), eq(workerAttempts.status, 'completed'), eq(workerAttempts.planRevision, revision))).orderBy(desc(workerAttempts.completedAt)).limit(1);
      const outputId = typeof completed?.result?.outputId === 'string' ? completed.result.outputId : null;
      const [output] = outputId
        ? await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.id, outputId), eq(workflowOutputs.workerAttemptId, completed!.id))).for('share')
        : await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.taskId, blocker.id), eq(workflowOutputs.createdByType, 'human'), eq(workflowOutputs.planRevision, revision), eq(workflowOutputs.type, 'attachment'))).orderBy(desc(workflowOutputs.createdAt)).limit(1).for('share');
      if (!output || output.taskId !== blocker.id || output.planRevision !== revision || output.availability !== 'available' || output.type !== 'attachment' || !output.referenceId || !output.attachmentFileVersionId) throw new ConflictError('Acceptance dependency evidence is unavailable', revision);
      await requireResource(tx, authority, 'document', output.referenceId);
      const [document] = await tx.select().from(documents).where(eq(documents.id, output.referenceId)).for('share');
      const [file] = await tx.select().from(documentFileVersions).where(and(eq(documentFileVersions.id, output.attachmentFileVersionId), eq(documentFileVersions.documentId, output.referenceId))).for('share');
      if (!document || !file || document.currentFileVersionId !== file.id || file.storageBackend !== 'local' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ConflictError('Acceptance dependency evidence changed', revision);
      try { const verified = await attachmentStorage().getVerifiedObject(file.objectKey, { sha256: file.sha256, sizeBytes: file.sizeBytes }); verified.body.destroy(); }
      catch { throw new ConflictError('Acceptance dependency evidence cannot be verified', revision); }
      const deliveries = output.workerAttemptId ? await tx.select({ repositoryId: thinGitDeliveries.repositoryId, commit: thinGitDeliveries.proposedHead }).from(thinGitDeliveries).where(and(eq(thinGitDeliveries.attemptId, output.workerAttemptId), eq(thinGitDeliveries.state, 'confirmed'))) : [];
      inputs.push({ taskId: blocker.id, outputId: output.id, documentId: document.id, fileVersion: file.version, sha256: file.sha256, sizeBytes: file.sizeBytes, mimeType: file.mimeType, originalFilename: file.originalFilename, kind: output.workerAttemptId ? 'worker' : 'human', attemptId: output.workerAttemptId ?? null, gitDeliveries: deliveries });
    }
    return inputs;
  };
  return {
    async listGitDeliveries(db: Database, projectId: string) {
      z.string().uuid().parse(projectId);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'human') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', projectId, 'project.manage');
        return tx.select({ delivery: thinGitDeliveries }).from(thinGitDeliveries)
          .innerJoin(repositories, eq(repositories.id, thinGitDeliveries.repositoryId))
          .where(and(eq(thinGitDeliveries.projectId, projectId), repositoryPredicate(authority)))
          .orderBy(desc(thinGitDeliveries.updatedAt)).limit(100).then(rows => rows.map(row => row.delivery));
      });
    },
    async reconcileGitDelivery(db: Database, raw: z.input<typeof workerGitReconcileSchema>) {
      const input = workerGitReconcileSchema.parse(raw);
      const inspect = (before?: { delivery: typeof thinGitDeliveries.$inferSelect; repository: typeof repositories.$inferSelect; attemptId: string }) => transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'human') throw new AuthorizationError();
        const [existing] = await tx.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.id, input.deliveryId));
        if (!existing) throw new NotFoundError('Delivery not found');
        await requireResource(tx, authority, 'project', existing.projectId, 'project.manage');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin') throw new ValidationError('Thin worker mode is not enabled');
        const [initialAttempt] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, existing.attemptId));
        if (!initialAttempt) throw new NotFoundError('Attempt not found');
        await tx.select().from(requirements).where(eq(requirements.id, initialAttempt.requirementId)).for('update');
        await tx.select().from(tasks).where(eq(tasks.id, initialAttempt.taskId)).for('update');
        const [attempt] = await tx.select({ id: workerAttempts.id, live: sql<boolean>`${workerAttempts.status} = 'running' AND ${workerAttempts.expiresAt} > clock_timestamp()` }).from(workerAttempts).where(eq(workerAttempts.id, existing.attemptId)).for('update');
        const [delivery] = await tx.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.id, existing.id)).for('update');
        if (!attempt || attempt.live || !delivery || !['pushing', 'uncertain', 'confirmed'].includes(delivery.state)) throw new ConflictError('Only an expired or finished submitted delivery can be reconciled', 0);
        const [repository] = await tx.select().from(repositories).where(and(eq(repositories.id, delivery.repositoryId), repositoryPredicate(authority))).for('share');
        const [link] = await tx.select().from(requirementRepositories).where(and(eq(requirementRepositories.requirementId, initialAttempt.requirementId), eq(requirementRepositories.repositoryId, delivery.repositoryId))).for('share');
        if (!repository || repository.status !== 'active' || link?.workingBranch !== delivery.targetBranch) throw new ConflictError('Repository or target changed', 0);
        if (before && (attempt.id !== before.attemptId || delivery.repositoryId !== before.delivery.repositoryId || delivery.targetBranch !== before.delivery.targetBranch || delivery.expectedHead !== before.delivery.expectedHead || delivery.proposedHead !== before.delivery.proposedHead || gitRepositoryIdentity(repository) !== gitRepositoryIdentity(before.repository))) throw new ConflictError('Delivery evidence changed', 0);
        if (before && delivery.state !== 'confirmed') {
          const [updated] = await tx.update(thinGitDeliveries).set({ state: 'confirmed', updatedAt: sql`clock_timestamp()` }).where(eq(thinGitDeliveries.id, delivery.id)).returning();
          await tx.insert(activityLog).values({ entityType: 'task', entityId: initialAttempt.taskId, action: 'worker_git_delivery_reconciled', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { deliveryId: delivery.id, attemptId: attempt.id, reason: safeText(input.reason, 2000) } });
          return { delivery: updated!, repository, attemptId: attempt.id };
        }
        return { delivery, repository, attemptId: attempt.id };
      });
      const before = await inspect();
      if (before.delivery.state === 'confirmed') return before.delivery;
      await verifyTrustedGitAncestry(before.repository, before.delivery.expectedHead, before.delivery.proposedHead, { fetch: options.forgeFetch });
      await readTrustedDirectMerge(before.repository, before.delivery.targetBranch, before.delivery.proposedHead, { fetch: options.forgeFetch });
      return (await inspect(before)).delivery;
    },
    async abandonPreparedGitDelivery(db: Database, raw: z.input<typeof workerGitAbandonPreparedSchema>) {
      const input = workerGitAbandonPreparedSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'human') throw new AuthorizationError();
        const [existing] = await tx.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.id, input.deliveryId));
        if (!existing) throw new NotFoundError('Delivery not found');
        await requireResource(tx, authority, 'project', existing.projectId, 'project.manage');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin') throw new ValidationError('Thin worker mode is not enabled');
        const [initialAttempt] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, existing.attemptId));
        if (!initialAttempt) throw new NotFoundError('Attempt not found');
        await tx.select().from(requirements).where(eq(requirements.id, initialAttempt.requirementId)).for('update');
        await tx.select().from(tasks).where(eq(tasks.id, initialAttempt.taskId)).for('update');
        const [attempt] = await tx.select({ id: workerAttempts.id, live: sql<boolean>`${workerAttempts.status} = 'running' AND ${workerAttempts.expiresAt} > clock_timestamp()` }).from(workerAttempts).where(eq(workerAttempts.id, existing.attemptId)).for('update');
        const [delivery] = await tx.select().from(thinGitDeliveries).where(eq(thinGitDeliveries.id, existing.id)).for('update');
        if (!attempt || attempt.live || !delivery || delivery.state !== 'prepared') throw new ConflictError('Only a stopped attempt with an unstarted push can release this delivery', 0);
        const [updated] = await tx.update(thinGitDeliveries).set({ state: 'abandoned', updatedAt: sql`clock_timestamp()` }).where(eq(thinGitDeliveries.id, delivery.id)).returning();
        await tx.insert(activityLog).values({ entityType: 'task', entityId: initialAttempt.taskId, action: 'worker_git_preparation_abandoned', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { deliveryId: delivery.id, attemptId: attempt.id, reason: safeText(input.reason, 2000) } });
        return updated!;
      });
    },
    async confirmGitDelivery(db: Database, raw: z.input<typeof workerGitConfirmSchema>) {
      const input = workerGitConfirmSchema.parse(raw);
      const inspect = () => transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, existing.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Attempt or plan is no longer current', requirement?.planRevision ?? 0);
        const [delivery] = await tx.select().from(thinGitDeliveries).where(and(eq(thinGitDeliveries.id, input.deliveryId), eq(thinGitDeliveries.attemptId, attempt.id))).for('update');
        if (!delivery) throw new NotFoundError('Delivery not found');
        if (!['pushing', 'uncertain', 'confirmed'].includes(delivery.state)) throw new ConflictError('Delivery has not been submitted', requirement.planRevision);
        const [repository] = await tx.select().from(repositories).where(and(eq(repositories.id, delivery.repositoryId), repositoryPredicate(authority))).for('share');
        const [link] = await tx.select().from(requirementRepositories).where(and(eq(requirementRepositories.requirementId, requirement.id), eq(requirementRepositories.repositoryId, delivery.repositoryId))).for('share');
        if (!repository || repository.status !== 'active' || link?.workingBranch !== delivery.targetBranch) throw new ConflictError('Repository or target changed', requirement.planRevision);
        return { delivery, repository, taskId: attempt.taskId, requirementId: attempt.requirementId, revision: requirement.planRevision };
      });
      const before = await inspect();
      if (before.delivery.state === 'confirmed') return before.delivery;
      await verifyTrustedGitAncestry(before.repository, before.delivery.expectedHead, before.delivery.proposedHead, { fetch: options.forgeFetch });
      await readTrustedDirectMerge(before.repository, before.delivery.targetBranch, before.delivery.proposedHead, { fetch: options.forgeFetch });
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        await requireResource(tx, authority, 'task', before.taskId, 'execution.run');
        const project = await lockProject(tx, before.delivery.projectId);
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, before.requirementId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, input.attemptId), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        if (!attempt || project.workerMode !== 'thin' || attempt.actorId !== authority.actor.id || attempt.credentialId !== context.credential.id || attempt.workerId !== input.workerId || attempt.tokenHash !== digest(input.token) || attempt.taskId !== before.taskId || attempt.requirementId !== before.requirementId) throw new AuthorizationError();
        await requireResource(tx, authority, 'task', attempt.taskId, 'resource.write');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, attempt.taskId)).for('update');
        const [delivery] = await tx.select().from(thinGitDeliveries).where(and(eq(thinGitDeliveries.id, input.deliveryId), eq(thinGitDeliveries.attemptId, attempt.id))).for('update');
        const [repository] = await tx.select().from(repositories).where(and(eq(repositories.id, before.repository.id), repositoryPredicate(authority))).for('share');
        const [link] = await tx.select().from(requirementRepositories).where(and(eq(requirementRepositories.requirementId, attempt.requirementId), eq(requirementRepositories.repositoryId, before.repository.id))).for('share');
        if (!requirement || !task || task.status !== 'in_progress' || requirement.planRevision !== attempt.planRevision || requirement.planRevision !== before.revision || !['approved', 'in_progress'].includes(requirement.status) || !repository || repository.status !== 'active' || gitRepositoryIdentity(repository) !== gitRepositoryIdentity(before.repository) || link?.workingBranch !== before.delivery.targetBranch || !delivery || delivery.expectedHead !== before.delivery.expectedHead || delivery.proposedHead !== before.delivery.proposedHead || delivery.targetBranch !== before.delivery.targetBranch || !['pushing', 'uncertain', 'confirmed'].includes(delivery.state)) throw new ConflictError('Delivery authority or evidence changed', requirement?.planRevision ?? 0);
        if (delivery.state === 'confirmed') return delivery;
        const [updated] = await tx.update(thinGitDeliveries).set({ state: 'confirmed', updatedAt: sql`clock_timestamp()` }).where(eq(thinGitDeliveries.id, delivery.id)).returning();
        return updated!;
      });
    },
    async transitionGitDelivery(db: Database, raw: z.input<typeof workerGitTransitionSchema>) {
      const input = workerGitTransitionSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, existing.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Attempt or plan is no longer current', requirement?.planRevision ?? 0);
        const [delivery] = await tx.select().from(thinGitDeliveries).where(and(eq(thinGitDeliveries.id, input.deliveryId), eq(thinGitDeliveries.attemptId, attempt.id))).for('update');
        if (!delivery) throw new NotFoundError('Delivery not found');
        // A replayed start response cannot authorize another external push: the first response may have been lost after the caller proceeded.
        if ((input.event === 'start_push' && delivery.state === 'pushing') || (input.event === 'response_lost' && delivery.state === 'uncertain')) return { delivery, shouldPush: false };
        let state: ReturnType<typeof advanceGitDelivery>;
        try { state = advanceGitDelivery(delivery.state, input.event); }
        catch { throw new ConflictError('Delivery state changed', requirement.planRevision); }
        const [updated] = await tx.update(thinGitDeliveries).set({ state, updatedAt: sql`clock_timestamp()` }).where(eq(thinGitDeliveries.id, delivery.id)).returning();
        return { delivery: updated!, shouldPush: input.event === 'start_push' };
      });
    },
    async prepareGitDelivery(db: Database, raw: z.input<typeof workerGitPrepareSchema>) {
      const input = workerGitPrepareSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, existing.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Attempt or plan is no longer current', requirement?.planRevision ?? 0);
        const [repository] = await tx.select().from(repositories).where(and(eq(repositories.id, input.repositoryId), repositoryPredicate(authority))).for('share');
        if (!repository) throw new NotFoundError('Resource not found');
        if (repository.status !== 'active') throw new ValidationError('Repository is archived');
        const [link] = await tx.select().from(requirementRepositories).where(and(eq(requirementRepositories.requirementId, requirement.id), eq(requirementRepositories.repositoryId, input.repositoryId))).for('share');
        if (!link?.workingBranch || link.workingBranch !== input.targetBranch) throw new ValidationError('Target must be the configured requirement branch');
        const [prior] = await tx.select().from(thinGitDeliveries).where(and(eq(thinGitDeliveries.projectId, project.id), eq(thinGitDeliveries.operationKey, input.operationKey)));
        if (prior) {
          if (prior.attemptId !== attempt.id || prior.repositoryId !== input.repositoryId || prior.targetBranch !== input.targetBranch || prior.expectedHead !== input.expectedHead || prior.proposedHead !== input.proposedHead) throw new ConflictError('Delivery operation key was already used', requirement.planRevision);
          return prior;
        }
        const [active] = await tx.select().from(thinGitDeliveries).where(and(eq(thinGitDeliveries.repositoryId, input.repositoryId), eq(thinGitDeliveries.targetBranch, input.targetBranch), sql`${thinGitDeliveries.state} IN ('prepared', 'pushing', 'uncertain')`));
        if (active) throw new ConflictError('Branch delivery is occupied or requires inspection', requirement.planRevision);
        const [delivery] = await tx.insert(thinGitDeliveries).values({ projectId: project.id, repositoryId: input.repositoryId, attemptId: attempt.id, operationKey: input.operationKey, targetBranch: input.targetBranch, expectedHead: input.expectedHead, proposedHead: input.proposedHead, state: 'prepared' }).returning();
        return delivery!;
      });
    },
    async presence(db: Database, raw: z.input<typeof workerPresenceSchema>) {
      const input = workerPresenceSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId, 'execution.run');
        const project = await lockProject(tx, input.projectId);
        if (project.workerMode !== 'thin') throw new ValidationError('Thin worker mode is not enabled');
        const activity = input.activity ?? 'unknown';
        const activityReason = input.reason ? safeText(input.reason, 1000) : null;
        const retryAt = input.retryAt ? new Date(input.retryAt) : null;
        const [row] = await tx.insert(thinWorkers).values({ id: input.workerId, projectId: input.projectId, actorId: authority.actor.id, credentialId: context.credential.id, nodeId: input.nodeId, activity, activityReason, retryAt }).onConflictDoUpdate({ target: thinWorkers.id, set: { heartbeatAt: sql`clock_timestamp()`, stoppedAt: null, activity, activityChangedAt: sql`CASE WHEN ${thinWorkers.activity} IS DISTINCT FROM ${activity} THEN clock_timestamp() ELSE ${thinWorkers.activityChangedAt} END`, activityReason, retryAt }, setWhere: and(eq(thinWorkers.projectId, input.projectId), eq(thinWorkers.actorId, authority.actor.id), eq(thinWorkers.credentialId, context.credential.id), eq(thinWorkers.nodeId, input.nodeId)) }).returning();
        if (!row) throw new ConflictError('Worker identity belongs to another registration', 0);
        return { workerId: row.id, nodeId: row.nodeId, heartbeatAt: row.heartbeatAt };
      });
    },
    async stopPresence(db: Database, raw: z.input<typeof workerPresenceSchema>) {
      const input = workerPresenceSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId, 'execution.run');
        const [row] = await tx.update(thinWorkers).set({ stoppedAt: sql`clock_timestamp()` }).where(and(eq(thinWorkers.id, input.workerId), eq(thinWorkers.projectId, input.projectId), eq(thinWorkers.nodeId, input.nodeId), eq(thinWorkers.actorId, authority.actor.id), eq(thinWorkers.credentialId, context.credential.id))).returning();
        if (!row) throw new NotFoundError('Worker not found');
        return { stopped: true };
      });
    },
    async listWorkers(db: Database, projectId: string) {
      z.string().uuid().parse(projectId);
      return transact(db, async (tx, authority) => {
        await requireResource(tx, authority, 'project', projectId);
        const rows = await tx.select().from(thinWorkers).where(eq(thinWorkers.projectId, projectId)).orderBy(sql`${thinWorkers.heartbeatAt} DESC`).limit(100);
        return rows.map(row => ({ workerId: row.id, nodeId: row.nodeId, heartbeatAt: row.heartbeatAt, activity: row.activity, activityChangedAt: row.activityChangedAt, reason: row.activityReason, retryAt: row.retryAt, status: !row.stoppedAt && Date.now() - row.heartbeatAt.getTime() <= 90000 ? 'online' : 'offline' }));
      });
    },
    async list(db: Database, projectId: string) {
      z.string().uuid().parse(projectId);
      return transact(db, async (tx, authority) => {
        await requireResource(tx, authority, 'project', projectId);
        const rows = await tx.select().from(workerAttempts).where(eq(workerAttempts.projectId, projectId)).orderBy(sql`${workerAttempts.createdAt} DESC`).limit(100);
        return rows.map(row => ({ ...publicAttempt(row), effectiveStatus: row.status === 'running' && row.expiresAt <= new Date() ? 'expired' : row.status }));
      });
    },
    async setMode(db: Database, raw: z.input<typeof workerModeSchema>) {
      const input = workerModeSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'human') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId, 'project.manage');
        const project = await lockProject(tx, input.projectId);
        if (project.workerMode === input.mode) return { mode: project.workerMode };
        const [busy] = await tx.execute(sql`SELECT 1 AS busy WHERE
          EXISTS (SELECT 1 FROM ${requirementClaims} rc JOIN ${requirements} r ON r.id = rc.requirement_id WHERE r.project_id = ${input.projectId}) OR
          EXISTS (SELECT 1 FROM ${taskClaims} tc JOIN ${tasks} t ON t.id = tc.task_id WHERE t.project_id = ${input.projectId}) OR
          EXISTS (SELECT 1 FROM ${tasks} t WHERE t.project_id = ${input.projectId} AND t.status = 'in_progress') OR
          EXISTS (SELECT 1 FROM ${executionControls} ec JOIN ${requirements} r ON r.id = ec.requirement_id WHERE ec.project_id = ${input.projectId} AND ec.phase NOT IN ('resumed', 'manual') AND NOT (ec.phase = 'blocked' AND r.status = 'draft')) OR
          EXISTS (SELECT 1 FROM ${thinGitDeliveries} gd WHERE gd.project_id = ${input.projectId} AND gd.state IN ('prepared', 'pushing', 'uncertain')) OR
          EXISTS (SELECT 1 FROM ${workerAttempts} wa WHERE wa.project_id = ${input.projectId} AND wa.status IN ('running', 'attention'))`) as unknown as Array<{ busy: number }>;
        if (busy) throw new ValidationError('Drain claims and resolve interrupted or uncertain work before changing worker mode');
        await tx.update(projects).set({ workerMode: input.mode }).where(eq(projects.id, input.projectId));
        await tx.insert(activityLog).values({ entityType: 'project', entityId: input.projectId, action: 'worker_mode_changed', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { from: project.workerMode, to: input.mode, inspection: safeText(input.inspection, 2000) } });
        return { mode: input.mode };
      });
    },
    async acquire(db: Database, raw: z.input<typeof workerAcquireSchema>) {
      const input = workerAcquireSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId, 'execution.run');
        await requireResource(tx, authority, 'project', input.projectId, 'resource.write');
        const project = await lockProject(tx, input.projectId);
        if (project.workerMode !== 'thin') throw new ValidationError('Thin worker mode is not enabled');
        const [running] = await tx.select({ id: workerAttempts.id }).from(workerAttempts).where(and(eq(workerAttempts.workerId, input.workerId), eq(workerAttempts.status, 'running')));
        if (running) throw new ConflictError('Worker already has an unresolved attempt', 0);
        const rows = await tx.execute(sql`
          SELECT t.id AS task_id, r.id AS requirement_id FROM ${tasks} t JOIN ${requirements} r ON r.id = t.requirement_id
          WHERE t.project_id = ${input.projectId} AND t.scope = 'project' AND t.status = 'todo'
            AND (t.assignee IS NULL OR (t.assignee_type = 'agent' AND t.assignee = ${authority.actor.id}))
            AND r.project_id = ${input.projectId} AND r.status IN ('approved', 'in_progress')
            AND (${input.requirementId ?? null}::uuid IS NULL OR r.id = ${input.requirementId ?? null}::uuid)
            AND NOT EXISTS (SELECT 1 FROM execution_controls ec WHERE ec.id = (SELECT latest.id FROM execution_controls latest WHERE latest.requirement_id = r.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AND ec.phase <> 'resumed')
            AND (t.requested_provider IS NULL OR t.requested_provider = 'codex')
            AND (t.requested_model IS NULL OR t.requested_model = ${input.model})
            AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(t.tags, ARRAY[]::text[])) tag WHERE tag LIKE 'capability:%' OR tag LIKE 'capability-any:%')
            AND (NOT EXISTS (SELECT 1 FROM unnest(COALESCE(t.tags, ARRAY[]::text[])) tag WHERE tag LIKE 'executor:%' OR tag LIKE 'tool:%') OR 'executor:codex' = ANY(COALESCE(t.tags, ARRAY[]::text[])) OR 'tool:codex' = ANY(COALESCE(t.tags, ARRAY[]::text[])))
            AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id WHERE d.task_id = t.id AND d.type = 'blocks' AND b.status <> 'done')
            AND NOT EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements b ON b.id = d.depends_on_requirement_id WHERE d.requirement_id = r.id AND d.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))
            AND NOT EXISTS (SELECT 1 FROM requirement_claims rc WHERE rc.requirement_id = r.id)
            AND NOT EXISTS (SELECT 1 FROM task_claims tc WHERE tc.task_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM worker_attempts wa WHERE wa.task_id = t.id AND wa.status IN ('running', 'attention'))
          ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at, t.id
          LIMIT 1 FOR UPDATE OF r, t
        `) as unknown as Array<{ task_id: string; requirement_id: string }>;
        const candidate = rows[0];
        if (!candidate) return { attempt: null, task: null };
        await requireResource(tx, authority, 'task', candidate.task_id, 'execution.run');
        await requireResource(tx, authority, 'task', candidate.task_id, 'resource.write');
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, candidate.requirement_id));
        // Recheck cross-row eligibility after acquiring the requirement and task locks.
        const [changed] = await tx.execute(sql`SELECT 1 AS changed WHERE
          EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id WHERE d.task_id = ${candidate.task_id} AND d.type = 'blocks' AND b.status <> 'done') OR
          EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements b ON b.id = d.depends_on_requirement_id WHERE d.requirement_id = ${candidate.requirement_id} AND d.type = 'blocks' AND b.status NOT IN ('done', 'cancelled')) OR
          EXISTS (SELECT 1 FROM execution_controls ec WHERE ec.id = (SELECT latest.id FROM execution_controls latest WHERE latest.requirement_id = ${candidate.requirement_id} ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AND ec.phase <> 'resumed') OR
          EXISTS (SELECT 1 FROM requirement_claims rc WHERE rc.requirement_id = ${candidate.requirement_id}) OR
          EXISTS (SELECT 1 FROM task_claims tc WHERE tc.task_id = ${candidate.task_id}) OR
          EXISTS (SELECT 1 FROM worker_attempts wa WHERE wa.task_id = ${candidate.task_id} AND wa.status IN ('running', 'attention'))`) as unknown as Array<{ changed: number }>;
        if (changed) return { attempt: null, task: null };
        const token = `twa_${randomBytes(32).toString('hex')}`;
        const [attempt] = await tx.insert(workerAttempts).values({ projectId: input.projectId, requirementId: candidate.requirement_id, taskId: candidate.task_id, actorId: authority.actor.id, credentialId: context.credential.id, workerId: input.workerId, nodeId: input.nodeId, tokenHash: digest(token), planRevision: requirement!.planRevision, expiresAt: sql`clock_timestamp() + ${input.durationSeconds} * interval '1 second'` }).returning();
        const [task] = await tx.update(tasks).set({ status: 'in_progress', version: sql`${tasks.version} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, candidate.task_id)).returning();
        await tx.insert(taskStatusLog).values({ taskId: candidate.task_id, fromStatus: 'todo', toStatus: 'in_progress', changedBy: authority.actor.id, changedByType: authority.actor.type, reason: 'Acquired by thin worker' });
        return { attempt: publicAttempt(attempt!), task, token };
      });
    },
    async heartbeat(db: Database, raw: z.input<typeof workerHeartbeatSchema>) {
      const input = workerHeartbeatSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin') throw new AuthorizationError();
        const [updated] = await tx.update(workerAttempts).set({ heartbeatAt: sql`clock_timestamp()`, expiresAt: sql`clock_timestamp() + ${input.durationSeconds} * interval '1 second'` }).where(and(eq(workerAttempts.id, input.attemptId), eq(workerAttempts.workerId, input.workerId), eq(workerAttempts.tokenHash, digest(input.token)), eq(workerAttempts.actorId, authority.actor.id), eq(workerAttempts.credentialId, context.credential.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`, sql`EXISTS (SELECT 1 FROM requirements r WHERE r.id = ${workerAttempts.requirementId} AND r.plan_revision = ${workerAttempts.planRevision} AND r.status IN ('approved', 'in_progress'))`)).returning();
        if (!updated) throw new ConflictError('Attempt expired or authority changed', 0);
        return publicAttempt(updated);
      });
    },
    async inputs(db: Database, raw: z.input<typeof workerFenceSchema>) {
      const input = workerFenceSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, existing.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || !task.tags?.includes('worker:acceptance') || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Acceptance attempt or plan changed', requirement?.planRevision ?? 0);
        const inputs = await acceptanceInputs(tx, authority, task.id, attempt.planRevision);
        const [live] = await tx.select({ id: workerAttempts.id }).from(workerAttempts).where(and(eq(workerAttempts.id, attempt.id), sql`${workerAttempts.expiresAt} > clock_timestamp()`));
        if (!live) throw new ConflictError('Acceptance attempt expired', requirement.planRevision);
        return { inputs };
      });
    },
    async registerOutput(db: Database, raw: z.input<typeof workerOutputSchema>) {
      const input = workerOutputSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        await requireResource(tx, authority, 'document', input.documentId);
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, input.attemptId), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Attempt or plan changed', requirement?.planRevision ?? 0);
        const [document] = await tx.select().from(documents).where(eq(documents.id, input.documentId)).for('share');
        if (!document || document.projectId !== project.id || document.form !== 'attachment' || document.createdBy !== authority.actor.id || document.createdAt < attempt.createdAt || !document.currentFileVersionId) throw new ValidationError('An attachment created by this attempt holder is required');
        const [file] = await tx.select().from(documentFileVersions).where(and(eq(documentFileVersions.id, document.currentFileVersionId), eq(documentFileVersions.documentId, document.id))).for('share');
        if (!file || file.storageBackend !== 'local' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ValidationError('Attachment is unavailable');
        try {
          const verified = await attachmentStorage().getVerifiedObject(file.objectKey, { sha256: file.sha256, sizeBytes: file.sizeBytes });
          verified.body.destroy();
        } catch { throw new ValidationError('Attachment could not be verified'); }
        const [stillLive] = await tx.select({ id: workerAttempts.id }).from(workerAttempts).where(and(eq(workerAttempts.id, attempt.id), sql`${workerAttempts.expiresAt} > clock_timestamp()`));
        if (!stillLive) throw new ConflictError('Attempt expired', requirement.planRevision);
        const summary = safeText(input.summary, 1000);
        const [prior] = await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.workerAttemptId, attempt.id), eq(workflowOutputs.referenceId, document.id), eq(workflowOutputs.attachmentFileVersionId, file.id), eq(workflowOutputs.summary, summary)));
        if (prior) return prior;
        await tx.update(requirements).set({ workflowStateRevision: sql`${requirements.workflowStateRevision} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(requirements.id, requirement.id));
        const [output] = await tx.insert(workflowOutputs).values({ requirementId: requirement.id, taskId: task.id, workerAttemptId: attempt.id, workflowRevision: requirement.workflowRevision, planRevision: attempt.planRevision, type: 'attachment', referenceId: document.id, attachmentFileVersionId: file.id, summary, createdBy: authority.actor.id, createdByType: authority.actor.type }).returning();
        await tx.insert(activityLog).values({ entityType: 'requirement', entityId: requirement.id, action: 'workflow_output_registered', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { outputId: output!.id, type: 'attachment', attemptId: attempt.id } });
        return output!;
      });
    },
    async applyPlan(db: Database, raw: z.input<typeof workerPlanSchema>) {
      const input = workerPlanSchema.parse(raw);
      return transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'project', existing.projectId, 'project.manage');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(and(eq(workerAttempts.id, input.attemptId), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).for('update');
        if (!attempt || !requirement || !task || task.status !== 'in_progress' || !task.tags?.includes('worker:coordinator') || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Coordinator attempt is no longer authorized', requirement?.planRevision ?? 0);
        const plan = input.plan, selected = plan.requirements[0];
        if (plan.projectId !== project.id || plan.requirements.length !== 1 || selected?.existingId !== requirement.id || plan.documents.length || plan.requirementDependencies.length || plan.documentLinks.length || plan.documentTaskLinks.length || plan.documentRequirementLinks.length || selected.dependsOn.length || selected.dependencies.length || selected.documents.length || selected.slices.length || selected.tasks.length < 2 || selected.tasks.length > 20) throw new ValidationError('Coordinator plan must contain only new tasks in its current requirement');
        const keys = new Set(selected.tasks.map(item => item.key));
        if (keys.size !== selected.tasks.length || selected.tasks.some(item => item.existingId || item.assignee || item.assigneeType || item.slice || item.branchName || item.documents.length || item.comments.length || item.notes.length)) throw new ValidationError('Coordinator plan contains unsupported task operations');
        const references = selected.tasks.flatMap(item => [...item.dependsOn, ...item.dependencies].map(dep => typeof dep === 'string' ? dep : dep.task));
        if (references.some(ref => !keys.has(ref)) || plan.taskDependencies.some(edge => !keys.has(edge.task) || !keys.has(edge.dependsOn))) throw new ValidationError('Coordinator task dependencies must stay within the new plan');
        const acceptance = selected.tasks.filter(item => item.tags?.includes('worker:acceptance'));
        if (acceptance.length !== 1) throw new ValidationError('Coordinator plan requires one acceptance task');
        const accept = acceptance[0]!;
        const blockers = new Set([...accept.dependsOn, ...accept.dependencies].flatMap(dep => typeof dep === 'string' ? [dep] : dep.type === 'blocks' ? [dep.task] : []));
        for (const edge of plan.taskDependencies) if (edge.task === accept.key && edge.type === 'blocks') blockers.add(edge.dependsOn);
        if (selected.tasks.some(item => item.key !== accept.key && !blockers.has(item.key))) throw new ValidationError('Acceptance must depend on every other planned task');
        const planDigest = digest(canonical(JSON.parse(JSON.stringify({ plan, expectedRevision: input.expectedRevision }))));
        const [prior] = await tx.select().from(workerPlanReceipts).where(and(eq(workerPlanReceipts.projectId, project.id), eq(workerPlanReceipts.operationKey, input.operationKey))).for('update');
        if (prior) {
          if (prior.attemptId !== attempt.id || prior.planDigest !== planDigest) throw new ConflictError('Plan operation key was already used', requirement.planRevision);
          const [draft] = await tx.select().from(planDrafts).where(eq(planDrafts.id, prior.draftId));
          if (!draft?.receipt) throw new ConflictError('Plan receipt is unavailable', requirement.planRevision);
          return { result: draft.receipt, planRevision: prior.resultingRevision, replayed: true };
        }
        if (requirement.planRevision !== input.expectedRevision || attempt.planRevision !== input.expectedRevision) throw new ConflictError('Plan changed; inspect and replan', requirement.planRevision);
        const actor = { id: authority.actor.id, type: authority.actor.type };
        const services = createResourceServices(context);
        const draft = await createPlanDraft(tx, { plan, source: 'assistant' }, actor);
        await validatePlanDraft(tx, project.id, draft.id, actor, services);
        const applied = await applyPlanDraft(tx, project.id, draft.id, draft.revision, input.operationKey, actor, services);
        const [current] = await tx.select().from(requirements).where(eq(requirements.id, requirement.id));
        const [live] = await tx.update(workerAttempts).set({ planRevision: current!.planRevision }).where(and(eq(workerAttempts.id, attempt.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).returning();
        if (!live) throw new ConflictError('Coordinator attempt expired before plan commit', current!.planRevision);
        await tx.insert(workerPlanReceipts).values({ projectId: project.id, attemptId: attempt.id, operationKey: input.operationKey, draftId: draft.id, planDigest, resultingRevision: current!.planRevision });
        return { result: applied.result, planRevision: current!.planRevision, replayed: false };
      });
    },
    async result(db: Database, raw: z.input<typeof workerResultSchema>) {
      const input = workerResultSchema.parse(raw);
      const result = await transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'agent' || context.credential.kind !== 'api_key') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'task', existing.taskId, 'execution.run');
        await requireResource(tx, authority, 'task', existing.taskId, 'resource.write');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin' || existing.actorId !== authority.actor.id || existing.credentialId !== context.credential.id || existing.workerId !== input.workerId || existing.tokenHash !== digest(input.token)) throw new AuthorizationError();
        const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId)).for('update');
        const result = { outcome: input.outcome, summary: safeText(input.summary, 4000), outputId: input.outputId ?? null, acceptanceDecision: input.acceptanceDecision ?? null };
        if (attempt?.status !== 'running') {
          if (attempt?.status !== 'resolved' && attempt?.resultKey === input.resultKey && attempt.result?.outcome === result.outcome && attempt.result?.summary === result.summary && attempt.result?.outputId === result.outputId && (attempt.result?.acceptanceDecision ?? null) === result.acceptanceDecision) return { attempt: publicAttempt(attempt), task };
          throw new ConflictError('Attempt already has a different result', 0);
        }
        if (!requirement || !task || task.status !== 'in_progress' || task.requirementId !== requirement.id || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Task or plan changed', requirement?.planRevision ?? 0);
        if (input.outcome === 'done') {
          const [unresolvedDelivery] = await tx.select({ id: thinGitDeliveries.id }).from(thinGitDeliveries).where(and(eq(thinGitDeliveries.attemptId, attempt.id), sql`${thinGitDeliveries.state} IN ('prepared', 'pushing', 'uncertain')`)).limit(1);
          if (unresolvedDelivery) throw new ConflictError('Git delivery must be resolved before task completion', requirement.planRevision);
        }
        const [blocked] = await tx.execute(sql`SELECT 1 AS blocked WHERE EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id WHERE d.task_id = ${task.id} AND d.type = 'blocks' AND b.status <> 'done') OR EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements b ON b.id = d.depends_on_requirement_id WHERE d.requirement_id = ${requirement.id} AND d.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))`) as unknown as Array<{ blocked: number }>;
        if (blocked) throw new ConflictError('Task dependencies changed', requirement.planRevision);
        if (input.outcome === 'done' && task.tags?.includes('worker:acceptance')) {
          if (input.acceptanceDecision !== 'accept') throw new ValidationError('Acceptance requires an explicit decision');
          await acceptanceInputs(tx, authority, task.id, attempt.planRevision);
        }
        if (input.outputId) {
          const [output] = await tx.select().from(workflowOutputs).where(and(eq(workflowOutputs.id, input.outputId!), eq(workflowOutputs.taskId, task.id), eq(workflowOutputs.requirementId, requirement.id))).for('share');
          if (!output || output.workerAttemptId !== attempt.id || output.planRevision !== attempt.planRevision || output.createdAt < attempt.createdAt || output.availability !== 'available' || output.type !== 'attachment' || !output.referenceId || !output.attachmentFileVersionId) throw new ValidationError('A current, available attempt attachment is required');
          await requireResource(tx, authority, 'document', output.referenceId);
          const [document] = await tx.select().from(documents).where(eq(documents.id, output.referenceId)).for('share');
          const [file] = await tx.select().from(documentFileVersions).where(and(eq(documentFileVersions.id, output.attachmentFileVersionId), eq(documentFileVersions.documentId, output.referenceId))).for('share');
          if (!document || document.currentFileVersionId !== file?.id || file.storageBackend !== 'local' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ValidationError('Output attachment is unavailable or changed');
          try {
            const verified = await attachmentStorage().getVerifiedObject(file.objectKey, { sha256: file.sha256, sizeBytes: file.sizeBytes });
            verified.body.destroy();
          } catch { throw new ValidationError('Output attachment could not be verified'); }
        }
        const [completed] = await tx.update(workerAttempts).set({ status: input.outcome === 'done' ? 'completed' : 'attention', resultKey: input.resultKey, result, completedAt: sql`clock_timestamp()` }).where(and(eq(workerAttempts.id, attempt.id), eq(workerAttempts.status, 'running'), sql`${workerAttempts.expiresAt} > clock_timestamp()`)).returning();
        if (!completed) throw new ConflictError('Attempt expired', requirement.planRevision);
        const nextStatus = input.outcome === 'done' ? 'done' : 'in_review';
        const [updated] = await tx.update(tasks).set({ status: nextStatus, completedAt: nextStatus === 'done' ? sql`clock_timestamp()` : null, version: sql`${tasks.version} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, task.id)).returning();
        await tx.insert(taskStatusLog).values({ taskId: task.id, fromStatus: 'in_progress', toStatus: nextStatus, changedBy: authority.actor.id, changedByType: authority.actor.type, reason: result.summary });
        return { attempt: publicAttempt(completed), task: updated };
      });
      if (result.task?.projectId) emit({ type: 'task_updated', projectId: result.task.projectId, taskId: result.task.id });
      return result;
    },
    async resolve(db: Database, raw: z.input<typeof workerResolveSchema>) {
      const input = workerResolveSchema.parse(raw);
      const result = await transact(db, async (tx, authority) => {
        if (authority.actor.type !== 'human') throw new AuthorizationError();
        const [existing] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId));
        if (!existing) throw new NotFoundError('Attempt not found');
        await requireResource(tx, authority, 'project', existing.projectId, 'project.manage');
        const project = await lockProject(tx, existing.projectId);
        if (project.workerMode !== 'thin') throw new ValidationError('Thin worker mode is not enabled');
        await tx.select().from(requirements).where(eq(requirements.id, existing.requirementId)).for('update');
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).for('update');
        const [attempt] = await tx.select().from(workerAttempts).where(eq(workerAttempts.id, input.attemptId)).for('update');
        if (!task || !attempt || !['in_progress', 'in_review'].includes(task.status)) throw new ConflictError('Task changed; inspect it before resolving the attempt', 0);
        if (input.disposition === 'retry') {
          const [unresolvedDelivery] = await tx.select({ id: thinGitDeliveries.id }).from(thinGitDeliveries).where(and(eq(thinGitDeliveries.attemptId, attempt.id), sql`${thinGitDeliveries.state} IN ('prepared', 'pushing', 'uncertain')`)).limit(1);
          if (unresolvedDelivery) throw new ConflictError('Resolve the Git delivery outcome before retrying', 0);
        }
        const [resolved] = await tx.update(workerAttempts).set({ status: 'resolved', completedAt: sql`COALESCE(${workerAttempts.completedAt}, clock_timestamp())` }).where(and(eq(workerAttempts.id, attempt.id), sql`(${workerAttempts.status} = 'attention' OR (${workerAttempts.status} = 'running' AND ${workerAttempts.expiresAt} <= clock_timestamp()))`)).returning();
        if (!resolved) throw new ConflictError('Attempt is still live or already resolved', 0);
        const nextStatus = input.disposition === 'retry' ? 'todo' : 'in_review';
        const [updated] = await tx.update(tasks).set({ status: nextStatus, version: sql`${tasks.version} + 1`, updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, task.id)).returning();
        const reason = safeText(input.reason, 2000);
        await tx.insert(taskStatusLog).values({ taskId: task.id, fromStatus: task.status, toStatus: nextStatus, changedBy: authority.actor.id, changedByType: authority.actor.type, reason });
        await tx.insert(activityLog).values({ entityType: 'task', entityId: task.id, action: 'worker_attempt_resolved', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { attemptId: attempt.id, disposition: input.disposition, retrySafe: input.retrySafe, reason } });
        return { attempt: publicAttempt(resolved), task: updated };
      });
      if (result.task?.projectId) emit({ type: 'task_updated', projectId: result.task.projectId, taskId: result.task.id });
      return result;
    },
  };
}
