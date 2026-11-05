import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { activityLog, documentFileVersions, documents, executionControls, projects, requirementClaims, requirements, taskClaims, taskStatusLog, tasks, workerAttempts, workflowOutputs, type Database } from '@task-weaver/db';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError, redactObservabilityText, workerModeSchema, workerAcquireSchema, workerHeartbeatSchema, workerOutputSchema, workerResolveSchema, workerResultSchema, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { resourceAuthority, requireResource } from './resource-authorization';
import { attachmentStorage } from './attachment-storage';
import { emit } from '@task-weaver/realtime';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const safeText = (value: string, limit: number) => redactObservabilityText(value, limit).value.replace(/\b(?:tw|twd|twb|twa)_[0-9a-f]{64}\b/gi, '[redacted]');
const publicAttempt = ({ tokenHash: _tokenHash, credentialId: _credentialId, ...attempt }: typeof workerAttempts.$inferSelect) => attempt;

/** The credential is held by the worker; executors never receive it. */
export function createThinWorkerService(context: VerifiedRequestContext) {
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
  return {
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
          EXISTS (SELECT 1 FROM ${executionControls} ec WHERE ec.project_id = ${input.projectId} AND ec.phase NOT IN ('resumed', 'manual')) OR
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
            AND r.project_id = ${input.projectId} AND r.status IN ('approved', 'in_progress')
            AND t.execution_slice_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM execution_slices es WHERE es.requirement_id = r.id AND es.status NOT IN ('done', 'cancelled'))
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
          EXISTS (SELECT 1 FROM execution_slices es WHERE es.requirement_id = ${candidate.requirement_id} AND es.status NOT IN ('done', 'cancelled')) OR
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
        const [output] = await tx.insert(workflowOutputs).values({ requirementId: requirement.id, taskId: task.id, workerAttemptId: attempt.id, workflowRevision: requirement.workflowRevision, planRevision: attempt.planRevision, type: 'attachment', referenceId: document.id, attachmentFileVersionId: file.id, summary, createdBy: authority.actor.id, createdByType: authority.actor.type }).returning();
        return output!;
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
        const result = { outcome: input.outcome, summary: safeText(input.summary, 4000), outputId: input.outputId ?? null };
        if (attempt?.status !== 'running') {
          if (attempt?.status !== 'resolved' && attempt?.resultKey === input.resultKey && attempt.result?.outcome === result.outcome && attempt.result?.summary === result.summary && attempt.result?.outputId === result.outputId) return { attempt: publicAttempt(attempt), task };
          throw new ConflictError('Attempt already has a different result', 0);
        }
        if (!requirement || !task || task.status !== 'in_progress' || task.requirementId !== requirement.id || requirement.planRevision !== attempt.planRevision || !['approved', 'in_progress'].includes(requirement.status)) throw new ConflictError('Task or plan changed', requirement?.planRevision ?? 0);
        const [blocked] = await tx.execute(sql`SELECT 1 AS blocked WHERE EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id WHERE d.task_id = ${task.id} AND d.type = 'blocks' AND b.status <> 'done') OR EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements b ON b.id = d.depends_on_requirement_id WHERE d.requirement_id = ${requirement.id} AND d.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))`) as unknown as Array<{ blocked: number }>;
        if (blocked) throw new ConflictError('Task dependencies changed', requirement.planRevision);
        if (input.outcome === 'done') {
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
