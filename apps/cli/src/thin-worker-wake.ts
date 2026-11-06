import { setTimeout as delay } from 'node:timers/promises'

/** SSE only hints at queue changes; every wake is followed by a fresh acquisition. */
export function startThinWake(options: { apiUrl: string; apiKey: string; projectId: string; fetch?: typeof fetch; reconnectMinMs?: number; reconnectMaxMs?: number }) {
  const controller = new AbortController()
  const fetcher = options.fetch ?? fetch
  let pending = false
  let listener: (() => void) | undefined
  let fatal: Error | undefined
  const notify = () => { pending = true; listener?.() }
  const run = async () => {
    let backoff = options.reconnectMinMs ?? 1000
    const maximum = options.reconnectMaxMs ?? 30000
    while (!controller.signal.aborted) {
      let received = false
      try {
        const connect = new AbortController()
        const timeout = setTimeout(() => connect.abort(), 10000)
        let response: Response
        try {
          const query = new URLSearchParams({ projectId: options.projectId })
          response = await fetcher(`${options.apiUrl}/api/v1/thin-workers/events?${query}`, { headers: { authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.any([controller.signal, connect.signal]), redirect: 'error' })
        } finally { clearTimeout(timeout) }
        if ([401, 403].includes(response.status)) { fatal = new Error(`Worker event access failed (${response.status})`); notify(); return }
        if (!response.ok || !response.body) throw new Error('Event stream unavailable')
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let buffer = ''
        try {
          while (!controller.signal.aborted) {
            const next = await reader.read()
            if (next.done) break
            buffer += decoder.decode(next.value, { stream: true })
            if (buffer.length > 65536) throw new Error('Event frame too large')
            const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
            for (const line of lines) {
              const event = /^event:\s*([a-z_]+)\s*\r?$/.exec(line)?.[1]
              if (event === 'connected' || event?.startsWith('task_') || event?.startsWith('requirement_')) { received = true; notify() }
            }
          }
        } finally { await reader.cancel().catch(() => undefined) }
      } catch { /* The next queue poll remains authoritative while disconnected. */ }
      if (controller.signal.aborted) break
      if (received) backoff = options.reconnectMinMs ?? 1000
      await delay(backoff, undefined, { signal: controller.signal }).catch(() => undefined)
      backoff = Math.min(maximum, Math.max(1, backoff * 2))
    }
  }
  const running = run()
  return {
    async wait(ms: number, signal?: AbortSignal) {
      if (fatal) throw fatal
      if (pending) { pending = false; return }
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, ms)
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); listener = undefined; resolve() }
        listener = done
        signal?.addEventListener('abort', done, { once: true })
        if (signal?.aborted || pending) done()
      })
      pending = false
      if (fatal) throw fatal
    },
    async close() { controller.abort(); listener?.(); await running },
  }
}
