import { emitDurable } from './durable-events';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { activityLog, daemons, executionControls, executionDelegations, executionSynchronizations, requirementRepositories, requirementClaims, requirements, tasks, taskStatusLog, type Database } from '@task-weaver/db';
import { acknowledgeExecutionControlSchema, executionAuthoritySchema, executionSynchronizationSchema, executionRecoveryDecisionSchema, resumeExecutionControlSchema, AuthorizationError, ConflictError, NotFoundError, ValidationError, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { resourceAuthority, requireResource } from './resource-authorization';
import { requireDaemonLease } from './daemon-lease-authorization';
import { applyRequirement } from './daemons';

async function resetInterruptedTasks(db: Database, requirementId: string, actor: { id: string; type: 'human' | 'agent' }, reason: string) {
  const active = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.requirementId, requirementId), eq(tasks.status, 'in_progress')));
  if (!active.length) return;
  await db.update(tasks).set({ status: 'todo', version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(and(eq(tasks.requirementId, requirementId), eq(tasks.status, 'in_progress')));
  await db.insert(taskStatusLog).values(active.map(task => ({ taskId: task.id, fromStatus: 'in_progress' as const, toStatus: 'todo' as const, changedBy: actor.id, changedByType: actor.type, reason })));
}

const phases = ['pending', 'received', 'stopping', 'stopped', 'reconciling', 'resumed', 'blocked', 'manual'];

/** Supervisor-only control protocol. Acknowledgments never restore an old execution capability. */
export function createExecutionControlService(context: VerifiedRequestContext) {
  async function transaction<T>(db: Database, daemonId: string, work: (tx: Database, authority: Awaited<ReturnType<typeof resourceAuthority>>, daemon: typeof daemons.$inferSelect) => Promise<T>) {
    return db.transaction(async transaction => {
      await lockIdentityLifecycle(transaction);
      const tx = transaction as unknown as Database;
      const authority = await resourceAuthority(tx, context);
      const daemon = await tx.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
      if (authority.bounds || authority.actor.type !== 'agent' || context.credential.kind !== 'api_key' || !daemon || daemon.actorId !== authority.actor.id) throw new AuthorizationError();
      return work(tx, authority, daemon);
    });
  }
  async function ownedControl(tx: Database, daemon: typeof daemons.$inferSelect, id: string, actorId: string) {
    const row = await tx.query.executionControls.findFirst({ where: eq(executionControls.id, id) });
    if (!row) throw new NotFoundError('Execution control not found');
    if (row.daemonId !== daemon.id) {
      const previous = await tx.query.daemons.findFirst({ where: eq(daemons.id, row.daemonId) });
      if (!daemon.nodeId || !previous || previous.actorId !== actorId || previous.nodeId !== daemon.nodeId) throw new AuthorizationError();
    }
    return row;
  }
  return {
    list(db: Database, daemonId: string) {
      return transaction(db, daemonId, async (tx, authority, daemon) => {
        const sameNode = tx.select({ id: daemons.id }).from(daemons).where(and(eq(daemons.actorId, authority.actor.id), daemon.nodeId ? eq(daemons.nodeId, daemon.nodeId) : sql`false`));
        const rows = await tx.select().from(executionControls).where(or(eq(executionControls.daemonId, daemonId), inArray(executionControls.daemonId, sameNode))).orderBy(desc(executionControls.updatedAt)).limit(200);
        const visible = [];
        for (const row of rows) {
          try { await requireResource(tx, authority, 'requirement', row.requirementId, 'execution.run'); visible.push(row); }
          catch (error) { if (!(error instanceof AuthorizationError || error instanceof NotFoundError)) throw error; }
        }
        return visible;
      });
    },
    acknowledge(db: Database, daemonId: string, id: string, raw: unknown) {
      const input = acknowledgeExecutionControlSchema.parse(raw);
      return transaction(db, daemonId, async (tx, authority, daemon) => {
        const row = await ownedControl(tx, daemon, id, authority.actor.id);
        await requireResource(tx, authority, 'requirement', row.requirementId, 'execution.run');
        if (input.revision !== row.revision) throw new ConflictError('Plan changed; read the latest execution control', row.revision);
        // A late old-node report cannot reopen an already resolved control.
        if (row.phase === 'resumed') return row;
        if (phases.indexOf(input.phase) < phases.indexOf(row.phase)) return row;
        if (input.phase === 'stopped' && !['stopping', 'stopped'].includes(row.phase)) throw new ValidationError('Report stopping before observed termination');
        if (input.phase === 'reconciling' && !['stopped', 'reconciling'].includes(row.phase)) throw new ValidationError('Observe termination before assessment');
        const [updated] = await tx.update(executionControls).set({ phase: input.phase, workspace: input.workspace ? { ...row.workspace, ...input.workspace } : row.workspace, updatedAt: new Date() }).where(eq(executionControls.id, id)).returning();
        await emitDurable(tx, { type: 'requirement_updated', projectId: row.projectId, requirementId: row.requirementId });
        return updated!;
      });
    },
    resume(db: Database, daemonId: string, id: string, raw: unknown = {}) {
      const input = resumeExecutionControlSchema.parse(raw);
      return transaction(db, daemonId, async (tx, authority, daemon) => {
        const row = await ownedControl(tx, daemon, id, authority.actor.id);
        await requireResource(tx, authority, 'requirement', row.requirementId, 'execution.run');
        await requireResource(tx, authority, 'requirement', row.requirementId, 'resource.write');
        if (!['stopped', 'reconciling'].includes(row.phase)) throw new ValidationError('Only an observed stopped execution may resume');
        let claim = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, row.requirementId) });
        if (claim && (claim.id !== row.runId || ![daemonId, row.daemonId].includes(claim.daemonId ?? '') || claim.claimedBy !== authority.actor.id)) throw new AuthorizationError();
        if (claim && claim.expiresAt <= new Date()) {
          await tx.delete(requirementClaims).where(eq(requirementClaims.id, claim.id));
          claim = undefined;
        }
        if (row.deadline <= new Date() && !row.workspace?.failure) {
          await tx.update(executionControls).set({ phase: 'manual', reason: 'Reconciliation deadline exceeded; preserved work requires inspection', updatedAt: new Date() }).where(eq(executionControls.id, id));
          await emitDurable(tx, { type: 'requirement_updated', projectId: row.projectId, requirementId: row.requirementId });
          return { requirement: null, recovery: 'manual' };
        }
        // Only interrupted runtime states are reset. Completed work remains historical evidence.
        await resetInterruptedTasks(tx, row.requirementId, authority.actor, 'Observed old execution stopped; reassessing against the latest plan');
        // Rotate the execution identifier while retaining a healthy lane; expired ownership needs a fresh lease.
        const oldWorkerIndex = input.workerIndex !== undefined ? String(input.workerIndex) : claim?.workerIndex ?? '0';
        let replacementRunId: string | undefined;
        if (claim) {
          replacementRunId = randomUUID();
          await tx.update(requirementClaims).set({ id: replacementRunId, daemonId, workerIndex: oldWorkerIndex }).where(eq(requirementClaims.id, claim.id));
        }
        const lane = await applyRequirement(tx, daemonId, row.projectId, Number(oldWorkerIndex), undefined, { id: authority.actor.id, type: authority.actor.type }, sql`r.id = ${row.requirementId}`, replacementRunId);
        if (!lane?.requirement) {
          await tx.delete(requirementClaims).where(eq(requirementClaims.requirementId, row.requirementId));
          await tx.update(executionControls).set({ phase: 'blocked', reason: 'Latest plan is not executable; workspace retained without occupying a worker', updatedAt: new Date() }).where(eq(executionControls.id, id));
          await emitDurable(tx, { type: 'requirement_updated', projectId: row.projectId, requirementId: row.requirementId });
          return { requirement: null, recovery: 'blocked' };
        }
        await tx.update(executionControls).set({ phase: 'resumed', updatedAt: new Date() }).where(eq(executionControls.id, id));
        await emitDurable(tx, { type: 'requirement_updated', projectId: row.projectId, requirementId: row.requirementId });
        return { ...lane, recovery: 'local_reassessment', planRevision: row.revision };
      });
    },
    authority(db: Database, daemonId: string, raw: unknown) {
      const input = executionAuthoritySchema.parse(raw);
      return transaction(db, daemonId, async (tx, authority) => {
        await requireDaemonLease(tx, authority, input.requirementId, { ...input, daemonId });
        return { active: true };
      });
    },
    synchronization(db: Database, daemonId: string, raw: unknown) {
      const input = executionSynchronizationSchema.parse(raw);
      return transaction(db, daemonId, async (tx, authority) => {
        const { requirement } = await requireDaemonLease(tx, authority, input.requirementId, { ...input, daemonId });
        const link = await tx.query.requirementRepositories.findFirst({ where: and(eq(requirementRepositories.requirementId, input.requirementId), eq(requirementRepositories.repositoryId, input.repositoryId)) });
        if (!link) throw new AuthorizationError();
        if (input.fetchedAt.getTime() > Date.now() + 5000 || input.fetchedAt.getTime() < Date.now() - 5 * 60_000) throw new ValidationError('Synchronization requires a fresh observed remote tip');
        const { leaseGeneration: _generation, ...inputValues } = input;
        const values = { ...inputValues, planRevision: requirement.planRevision };
        const [sync] = await tx.insert(executionSynchronizations).values(values).onConflictDoUpdate({ target: [executionSynchronizations.runId, executionSynchronizations.repositoryId], set: { ...values, verifiedAt: new Date() } }).returning();
        await emitDurable(tx, { type: 'requirement_updated', projectId: requirement.projectId, requirementId: requirement.id });
        return sync!;
      });
    },
    async authorizeRecovery(db: Database, requirementId: string, raw: unknown) {
      const input = executionRecoveryDecisionSchema.parse(raw);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        if (authority.bounds || authority.actor.type !== 'human') throw new AuthorizationError();
        await requireResource(tx, authority, 'requirement', requirementId, 'project.manage');
        const requirement = await tx.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
        const control = await tx.query.executionControls.findFirst({ where: and(eq(executionControls.id, input.controlId), eq(executionControls.requirementId, requirementId)) });
        if (!requirement || !control) throw new NotFoundError('Execution recovery not found');
        if (requirement.planRevision !== input.expectedPlanRevision) throw new ConflictError('Plan changed; inspect the latest recovery state', requirement.planRevision);
        const latest = await tx.select({ id: executionControls.id }).from(executionControls).where(eq(executionControls.requirementId, requirementId)).orderBy(desc(executionControls.createdAt), desc(executionControls.id)).limit(1);
        if (latest[0]?.id !== control.id || control.phase === 'resumed' || ['done', 'cancelled', 'archived'].includes(requirement.status)) throw new ConflictError('Recovery state changed; inspect the latest control', requirement.planRevision);
        if ((input.expectedControlUpdatedAt && control.updatedAt.getTime() !== input.expectedControlUpdatedAt.getTime()) || (input.expectedControlPhase && control.phase !== input.expectedControlPhase)) throw new ConflictError('Control observation changed; inspect current evidence', requirement.planRevision);
        const claim = await tx.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirementId) });
        if (claim && claim.id !== control.runId) throw new ValidationError('A replacement already owns execution; inspect its results before deciding');
        await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(eq(executionDelegations.runId, control.runId));
        if (claim) await tx.delete(requirementClaims).where(eq(requirementClaims.id, claim.id));
        await resetInterruptedTasks(tx, requirementId, authority.actor, `Human-authorized recovery: ${input.reason}`);
        await tx.update(executionControls).set({ phase: 'resumed', reason: `Human-authorized recovery after outcome/input verification: ${input.reason}`, updatedAt: new Date() }).where(eq(executionControls.id, control.id));
        await tx.insert(activityLog).values({ entityType: 'requirement', entityId: requirementId, action: 'execution_recovery_authorized', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { controlId: control.id, reason: input.reason, planRevision: input.expectedPlanRevision } });
        await emitDurable(tx, { type: 'requirement_updated', projectId: requirement.projectId, requirementId });
        return { authorized: true, warning: 'Old local work is preserved candidate evidence; this decision does not prove remote process termination' };
      });
    },
    async revalidate(db: Database, requirementId: string, reason: string, expectedPlanRevision: number) {
      if (!reason.trim()) throw new ValidationError('Revalidation requires evidence and a reason');
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        if (authority.bounds || authority.actor.type !== 'human') throw new AuthorizationError();
        await requireResource(tx, authority, 'requirement', requirementId, 'resource.write');
        const requirement = await tx.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
        if (!requirement || requirement.planRevision !== expectedPlanRevision) throw new ConflictError("Plan changed; inspect the latest evidence", requirement?.planRevision ?? 0);
        await tx.update(requirements).set({ evidenceNeedsReview: false }).where(eq(requirements.id, requirementId));
        await tx.insert(activityLog).values({ entityType: 'requirement', entityId: requirementId, action: 'execution_evidence_revalidated', actorId: authority.actor.id, actorType: authority.actor.type, metadata: { reason } });
        await emitDurable(tx, { type: 'requirement_updated', projectId: requirement.projectId, requirementId });
        return { revalidated: true };
      });
    },
  };
}
