export interface ExecutionControl {
  id: string
  runId: string
  requirementId?: string
  revision: number
  phase: string
  reason: string
  deadline: string
}

/** Durable records, rather than event order, determine which execution to stop. */
export function monitorExecutionControl(options: {
  runId: string
  list: () => Promise<ExecutionControl[]>
  acknowledge: (control: ExecutionControl, phase: 'received' | 'stopping') => Promise<unknown>
  stop: () => void
  intervalMs?: number
}) {
  let closed = false
  let polling = false
  let stopped = false
  const tick = async () => {
    if (closed || polling || stopped) return
    polling = true
    try {
      const control = (await options.list()).find(row => row.runId === options.runId)
      if (!control || closed) return
      // Even a lost acknowledgment must not leave invalidated work running.
      await options.acknowledge(control, 'received').catch(() => undefined)
      await options.acknowledge(control, 'stopping').catch(() => undefined)
      if (!closed) { stopped = true; options.stop() }
    } catch { /* The access broker independently fails closed when authority cannot be verified. */ }
    finally { polling = false }
  }
  const timer = setInterval(() => { void tick() }, options.intervalMs ?? 1000)
  timer.unref()
  void tick()
  return { tick, close() { closed = true; clearInterval(timer) } }
}
