import { randomUUID } from 'node:crypto'

/** Parent-owned replay. Notifications only request a replay; they confer no authority. */
export function createDaemonEventConsumer(options: {
  projectId: string
  consumer: string
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body: unknown) => Promise<T>
  handle: (events: unknown[]) => Promise<void>
  report: (message: string) => void
  intervalMs?: number
}) {
  let closed = false
  let running = false
  let pending = false
  let expired = false
  let cursor: string | undefined
  const owner = randomUUID()
  const durationMs = 30000
  let generation: string | undefined
  const leaseInput = { projectId: options.projectId, consumer: options.consumer, owner, durationMs }
  const renew = async () => {
    try {
      const result = await options.post<{ generation: string }>('/api/v1/events/lease/renew', { ...leaseInput, generation })
      if (result.generation !== generation) throw new Error('Invalid lease renewal')
    } catch (error) {
      generation = undefined
      throw error
    }
  }
  const query = (extra: Record<string, string>) => new URLSearchParams({ projectId: options.projectId, ...extra }).toString()
  const tick = async () => {
    if (closed || expired) return
    if (running) { pending = true; return }
    running = true
    try {
      if (!generation) {
        const lease = await options.post<{ status: string; generation?: string }>('/api/v1/events/lease/acquire', leaseInput)
        if (closed) return
        if (lease.status === 'busy') return
        if (lease.status !== 'acquired' || !lease.generation) throw new Error('Invalid lease acquisition')
        generation = lease.generation
        cursor = undefined
      } else {
        await renew()
        if (closed) return
      }
      if (cursor === undefined) {
        const checkpoint = await options.get<{ status: string; cursor: string; retentionFloor: string }>(`/api/v1/events/checkpoint?${query({ consumer: options.consumer })}`)
        cursor = checkpoint.cursor
        if (checkpoint.status === 'expired') {
          expired = true
          options.report(`Event cursor expired for project ${options.projectId}, consumer ${options.consumer} at ${cursor}; retention floor ${checkpoint.retentionFloor}. Review lost history and resynchronize before continuing.`)
          return
        }
      }
      do {
        pending = false
        const batch: { status: string; cursor: string; retentionFloor: string; events?: unknown[] } = await options.get(`/api/v1/events?${query({ cursor: cursor!, limit: '100' })}`)
        if (closed) return
        if (batch.status === 'expired') {
          expired = true
          options.report(`Event cursor expired for project ${options.projectId} at ${cursor}; retention floor ${batch.retentionFloor}. Resynchronization requires review.`)
          return
        }
        if (batch.status !== 'valid' || !batch.events) throw new Error('Invalid event replay response')
        await renew()
        if (closed) return
        await options.handle(batch.events)
        if (closed) return
        if (batch.cursor !== cursor) {
          await renew()
          if (closed) return
          const ack: { status: string; cursor: string; retentionFloor: string } = await options.post('/api/v1/events/ack/fenced', { projectId: options.projectId, consumer: options.consumer, owner, generation, cursor: batch.cursor })
          if (closed) return
          if (ack.status === 'expired') {
            expired = true
            options.report(`Event checkpoint expired for project ${options.projectId}; retention floor ${ack.retentionFloor}. Resynchronization requires review.`)
            return
          }
          if (ack.status !== 'valid') throw new Error('Invalid event acknowledgment')
          cursor = ack.cursor
          pending = true
        }
      } while (pending && !closed)
    } catch (error) {
      // Reload the persisted checkpoint after uncertain replay or acknowledgment outcomes.
      cursor = undefined
      if (!closed) options.report(`Event replay failed for project ${options.projectId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, options.intervalMs ?? 5000)
  timer.unref()
  void tick()
  return { tick, close() { closed = true; clearInterval(timer) } }
}
