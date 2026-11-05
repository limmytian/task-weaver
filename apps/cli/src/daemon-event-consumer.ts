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
  const query = (extra: Record<string, string>) => new URLSearchParams({ projectId: options.projectId, ...extra }).toString()
  const tick = async () => {
    if (closed || expired) return
    if (running) { pending = true; return }
    running = true
    try {
      if (cursor === undefined) cursor = (await options.get<{ cursor: string }>(`/api/v1/events/checkpoint?${query({ consumer: options.consumer })}`)).cursor
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
        await options.handle(batch.events)
        if (closed) return
        if (batch.cursor !== cursor) {
          const ack: { status: string; cursor: string; retentionFloor: string } = await options.post('/api/v1/events/ack', { projectId: options.projectId, consumer: options.consumer, cursor: batch.cursor })
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
