/** Execution inputs are intentionally separate from display and scheduler metadata. */
const executionFields: Record<string, readonly string[]> = {
  updateTask: ['title', 'description', 'requirementId', 'executionSliceId', 'assignee', 'assigneeType', 'branchName', 'tags', 'requestedProvider', 'requestedModel'],
  updateRequirement: ['title', 'description', 'branchName', 'workflow', 'workflowPreset', 'tags'],
  updateExecutionSlice: ['title', 'description', 'orderIndex', 'allowParallel', 'taskIds'],
};
const structuralOperations = new Set([
  'createTask', 'batchCreateTasks', 'deleteTask', 'createExecutionSlice', 'deleteExecutionSlice',
  'addTaskDependency', 'removeTaskDependency', 'addRequirementDependency', 'removeRequirementDependency',
  'addRequirementRepository', 'removeRequirementRepository', 'addTaskRepository', 'removeTaskRepository',
  'updateRepository', 'archiveRepository', 'addWorkflowInput', 'retireWorkflowOutput', 'deleteRequirement', 'reportWorkflowOutputAvailability',
]);

export function isExecutionPlanChange(operation: string, fields: Record<string, unknown> = {}, previous: Record<string, unknown> = {}) {
  if (structuralOperations.has(operation)) return true;
  if (operation === 'updateTaskStatus') return ['todo', 'cancelled'].includes(String(fields.status));
  if (operation === 'updateRequirement' && fields.status !== undefined && fields.status !== previous.status
    && ['draft', 'approved', 'in_progress', 'cancelled', 'archived'].includes(String(fields.status))) return true;
  if (operation === 'updateExecutionSlice' && ['todo', 'cancelled'].includes(String(fields.status)) && previous.status !== fields.status) return true;
  return (executionFields[operation] ?? []).some(key => key in fields && JSON.stringify(fields[key]) !== JSON.stringify(previous[key]));
}

export type RecoveryPolicy = { retrySafe: boolean; maxAttempts: number; graceMs: number };
/** Unknown external effects are never silently declared replay-safe. */
export function recoveryDisposition(input: { now: number; lastObservedAt: number; authorityExpiresAt: number; revoked: boolean; attempts: number; policy: RecoveryPolicy; sameNode: boolean; stopped: boolean; inputsAvailable: boolean; uncertainEffects: boolean }) {
  if (!input.inputsAvailable) return 'input_unavailable' as const;
  if (input.uncertainEffects) return 'manual_external_outcome' as const;
  if (!input.revoked && input.now < input.authorityExpiresAt) return 'awaiting_authority' as const;
  if (input.sameNode && input.stopped) return 'local_reassessment' as const;
  if (input.now < input.lastObservedAt + input.policy.graceMs) return 'awaiting_node' as const;
  if (!input.policy.retrySafe) return 'manual_retry_safety' as const;
  if (input.attempts >= input.policy.maxAttempts) return 'retry_exhausted' as const;
  return 'restart_with_possible_local_loss' as const;
}
