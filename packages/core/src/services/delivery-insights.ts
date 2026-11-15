import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { activityLog, requirements, tasks, workerAttempts, type Database } from '@task-weaver/db';
import { AuthorizationError, ValidationError, deliveryInsightsQuerySchema, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { requireResource, resourceAuthority, taskResourcePredicate } from './resource-authorization';

export function createDeliveryInsightsService(context: VerifiedRequestContext) {
  return {
    async summary(db: Database, raw: unknown) {
      const input = deliveryInsightsQuerySchema.parse(raw);
      return db.transaction(async transaction => {
        await lockIdentityLifecycle(transaction);
        const tx = transaction as unknown as Database;
        const authority = await resourceAuthority(tx, context);
        if (authority.bounds || authority.actor.type !== 'human') throw new AuthorizationError();
        await requireResource(tx, authority, 'project', input.projectId);
        await requireResource(tx, authority, 'project', input.projectId, 'audit.read');
        if (input.requirementId) {
          const requirement = await requireResource(tx, authority, 'requirement', input.requirementId);
          if (requirement.projectId !== input.projectId) throw new ValidationError('Requirement must belong to the selected project');
        }
        const requirementScope = and(eq(requirements.projectId, input.projectId), input.requirementId ? eq(requirements.id, input.requirementId) : undefined);
        const window = (column: typeof activityLog.createdAt | typeof workerAttempts.createdAt) => and(input.since ? gte(column, new Date(input.since)) : undefined, input.until ? lt(column, new Date(input.until)) : undefined);
        const [decisions] = await tx.select({
          accepted: sql<number>`count(*) filter (where ${activityLog.metadata}->>'decision' = 'complete' and ${activityLog.metadata}->'to'->>'acceptance' = 'complete')::int`,
          changesRequested: sql<number>`count(*) filter (where ${activityLog.metadata}->>'decision' = 'changes_requested')::int`,
        }).from(activityLog).innerJoin(requirements, eq(requirements.id, activityLog.entityId)).where(and(requirementScope, eq(activityLog.entityType, 'requirement'), eq(activityLog.action, 'workflow_stage_advanced'), sql`${activityLog.metadata}->>'stage' = 'acceptance'`, window(activityLog.createdAt)));
        const [attempts] = await tx.select({
          count: sql<number>`count(*)::int`, tasks: sql<number>`count(distinct ${workerAttempts.taskId})::int`,
          acceptedReviews: sql<number>`count(*) filter (where ${workerAttempts.status} = 'completed' and ${workerAttempts.result}->>'acceptanceDecision' = 'accept')::int`,
          changesRequested: sql<number>`count(*) filter (where ${workerAttempts.result}->>'acceptanceDecision' = 'changes_requested')::int`,
          completedDurations: sql<number>`count(*) filter (where ${workerAttempts.completedAt} >= ${workerAttempts.createdAt})::int`,
          meanDurationSeconds: sql<number | null>`avg(extract(epoch from (${workerAttempts.completedAt} - ${workerAttempts.createdAt}))) filter (where ${workerAttempts.completedAt} >= ${workerAttempts.createdAt})::float8`,
        }).from(workerAttempts).innerJoin(tasks, eq(tasks.id, workerAttempts.taskId)).innerJoin(requirements, eq(requirements.id, workerAttempts.requirementId)).where(and(requirementScope, eq(workerAttempts.projectId, input.projectId), eq(tasks.projectId, input.projectId), eq(tasks.requirementId, requirements.id), taskResourcePredicate(authority), window(workerAttempts.createdAt)));
        const [recovery] = await tx.select({ decisions: sql<number>`count(*)::int` }).from(activityLog).innerJoin(tasks, eq(tasks.id, activityLog.entityId)).innerJoin(requirements, eq(requirements.id, tasks.requirementId)).where(and(requirementScope, taskResourcePredicate(authority), eq(activityLog.entityType, 'task'), eq(activityLog.actorType, 'human'), sql`${activityLog.action} in ('worker_attempt_resolved', 'worker_git_delivery_reconciled')`, window(activityLog.createdAt)));
        const reviewDecisions = decisions!.accepted + decisions!.changesRequested;
        return { observedAt: new Date().toISOString(), workflow: { ...decisions!, reviewDecisions, acceptanceRate: reviewDecisions ? decisions!.accepted / reviewDecisions : null },
          worker: { ...attempts!, additionalAttempts: attempts!.count - attempts!.tasks }, humanRecoveryDecisions: recovery!.decisions,
          coverage: 'Visible retained evidence only. Requirement decisions and worker reviews are separate. Task completion is not acceptance. Durations include waiting and recovery; they are not model execution time. Additional attempts within the selected window are not a defect count.' };
      });
    },
  };
}
