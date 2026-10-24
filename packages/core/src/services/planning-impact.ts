import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { executionControls, executionDelegations, executionSlices, requirementClaims, requirementDependencies, requirementRepositories, requirements, taskDependencies, taskClaims, tasks, tiAgentRuns, workflowInputs, workflowOutputs, type Database } from '@task-weaver/db';
import { isExecutionPlanChange } from './planning-impact-policy';
import { emitDurable } from './durable-events';

/** Runs under the resource-service identity lock, before the mutation changes its old relationships. */
export async function planningImpact(db: Database, operation: string, call: any[]): Promise<string[]> {
  if (operation === 'batchUpdateTasks') {
    const targets = await Promise.all(call[1].updates.map(async (update: any) => [...await planningImpact(db, 'updateTask', [db, update.id, update]), ...('status' in update ? await planningImpact(db, 'updateTaskStatus', [db, update.id, update.status]) : [])]));
    return [...new Set(targets.flat() as string[])];
  }
  let previous: any;
  const id = call[1];
  if (['updateTask', 'updateTaskStatus'].includes(operation)) previous = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (operation === 'updateRequirement') previous = await db.query.requirements.findFirst({ where: eq(requirements.id, id) });
  if (operation === 'updateExecutionSlice') previous = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, id) });
  if (['updateDocument', 'revertDocument', 'deleteDocument'].includes(operation)) {
    if (operation === 'updateDocument' && !('content' in (call[2] ?? {}))) return [];
    const outputs = await db.select({ id: workflowOutputs.id }).from(workflowOutputs).where(and(eq(workflowOutputs.referenceId, id), eq(workflowOutputs.type, 'attachment')));
    if (!outputs.length) return [];
    const consumers = await db.select().from(workflowInputs).where(inArray(workflowInputs.outputId, outputs.map(output => output.id)));
    return [...new Set(consumers.map(input => input.requirementId))];
  }
  if (operation === 'reportWorkflowOutputAvailability') {
    const output = await db.query.workflowOutputs.findFirst({ where: eq(workflowOutputs.id, call[2]?.outputId) });
    if (!output || output.availability === call[2]?.availability) return [];
    const consumers = await db.select().from(workflowInputs).where(eq(workflowInputs.outputId, output.id));
    return [...new Set(consumers.map(input => input.requirementId))];
  }
  const fields = operation === 'updateTaskStatus' ? { status: call[2] } : call[2];
  if (!isExecutionPlanChange(operation, fields, previous)) return [];
  const affected = new Set<string>();
  const addTask = async (taskId: string) => {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (task?.requirementId) affected.add(task.requirementId);
  };
  if (['createTask', 'batchCreateTasks'].includes(operation)) {
    const entries = operation === 'createTask' ? [call[1]] : call[1].tasks;
    for (const task of entries ?? []) if (task.requirementId) affected.add(task.requirementId);
  } else if (['addTaskDependency', 'updateTask', 'updateTaskStatus', 'deleteTask', 'addTaskRepository', 'removeTaskRepository'].includes(operation)) {
    await addTask(id);
    if (operation === 'updateTask' && fields?.requirementId) affected.add(fields.requirementId);
  } else if (operation === 'removeTaskDependency') {
    const edge = await db.query.taskDependencies.findFirst({ where: eq(taskDependencies.id, id) });
    if (edge) await addTask(edge.taskId);
  } else if (['updateExecutionSlice', 'deleteExecutionSlice'].includes(operation)) {
    const slice = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, id) });
    if (slice) affected.add(slice.requirementId);
  } else if (operation === 'removeRequirementDependency') {
    const edge = await db.query.requirementDependencies.findFirst({ where: eq(requirementDependencies.id, id) });
    if (edge) affected.add(edge.requirementId);
  } else if (['updateRepository', 'archiveRepository'].includes(operation)) {
    const links = await db.select().from(requirementRepositories).where(eq(requirementRepositories.repositoryId, id));
    for (const link of links) affected.add(link.requirementId);
  } else affected.add(id);
  // Reopening an upstream task or changing its inputs also invalidates active consumers.
  if (['updateTask', 'updateTaskStatus', 'deleteTask'].includes(operation)) {
    const visited = new Set<string>();
    const visit = async (taskId: string): Promise<void> => {
      if (visited.has(taskId)) return;
      visited.add(taskId);
      const edges = await db.select().from(taskDependencies).where(and(eq(taskDependencies.dependsOnTaskId, taskId), eq(taskDependencies.type, 'blocks')));
      for (const edge of edges) { await addTask(edge.taskId); await visit(edge.taskId); }
    };
    await visit(id);
  }
  // Requirement DAG and explicitly declared input consumers remain affected even in draft.
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    const edges = await db.select().from(requirementDependencies).where(and(eq(requirementDependencies.dependsOnRequirementId, queue[i]!), eq(requirementDependencies.type, 'blocks')));
    for (const edge of edges) if (!affected.has(edge.requirementId)) { affected.add(edge.requirementId); queue.push(edge.requirementId); }
  }
  if (operation === 'retireWorkflowOutput') {
    const inputs = await db.select().from(workflowInputs).where(eq(workflowInputs.outputId, call[2]));
    for (const input of inputs) affected.add(input.requirementId);
  }
  return [...affected];
}

/** Called after a successful mutation, in its transaction. Notification delivery is not the fence. */
export async function invalidatePlanningExecutions(db: Database, ids: string[], reason: string, previousClaims: Array<typeof requirementClaims.$inferSelect> = []) {
  for (const id of [...new Set(ids)].sort()) {
    const [requirement] = await db.update(requirements).set({ planRevision: sql`${requirements.planRevision} + 1` }).where(eq(requirements.id, id)).returning();
    if (!requirement) continue;
    const done = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.requirementId, id), eq(tasks.status, 'done'))).limit(1);
    const outputs = await db.select({ id: workflowOutputs.id }).from(workflowOutputs).where(eq(workflowOutputs.requirementId, id)).limit(1);
    if (done.length || outputs.length) await db.update(requirements).set({ evidenceNeedsReview: true }).where(eq(requirements.id, id));
    const affectedTasks = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.requirementId, id));
    await db.update(tiAgentRuns).set({ status: 'cancelled', completedAt: new Date(), leaseExpiresAt: new Date() }).where(and(inArray(tiAgentRuns.taskId, affectedTasks), inArray(tiAgentRuns.status, ['queued', 'running', 'in_review'])));
    await db.update(executionDelegations).set({ revokedAt: new Date() }).where(and(eq(executionDelegations.requirementId, id), isNull(executionDelegations.revokedAt)));
    const claim = previousClaims.find(claim => claim.requirementId === id) ?? await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, id) });
    if (!claim?.daemonId) continue;
    await db.delete(taskClaims).where(and(inArray(taskClaims.taskId, affectedTasks), eq(taskClaims.claimedBy, claim.claimedBy), eq(taskClaims.claimedByType, 'agent')));
    const now = new Date();
    const [control] = await db.insert(executionControls).values({ requirementId: id, projectId: requirement.projectId, daemonId: claim.daemonId, runId: claim.id, revision: requirement.planRevision, reason,
      deadline: new Date(now.getTime() + 5 * 60_000) }).onConflictDoUpdate({ target: executionControls.runId,
      set: { revision: requirement.planRevision, reason, updatedAt: now } }).returning();
    await emitDurable(db, { type: 'requirement_execution_invalidated', projectId: requirement.projectId, requirementId: id, daemonId: claim.daemonId, runId: claim.id, controlId: control!.id, revision: requirement.planRevision });
  }
}

export async function assertRunNotInvalidated(db: Database, runId: string) {
  const control = await db.query.executionControls.findFirst({ where: eq(executionControls.runId, runId) });
  if (control) {
    const { AuthorizationError } = await import('@task-weaver/contracts');
    throw new AuthorizationError();
  }
}
