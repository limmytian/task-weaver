/** Activate a continuation using the server's dependency and lease guards. */
export async function activateContinuation<T extends { id: string; status: string; executionSliceId?: string | null }>(
  currentTaskId: string,
  tasks: T[],
  originalTaskIds: Set<string>,
  sliceId: string | null,
  activate: (taskId: string) => Promise<unknown>,
): Promise<T | undefined> {
  if (tasks.find(task => task.id === currentTaskId)?.status !== 'done') return undefined
  const next = tasks.find(task => task.status === 'todo'
    && (task.executionSliceId ?? null) === sliceId
    && originalTaskIds.has(task.id))
  if (!next) return undefined
  // Do not bypass dependency checks. On rejection the caller releases the lane,
  // allowing the scheduler to select an eligible task on the next acquisition.
  await activate(next.id)
  return next
}
