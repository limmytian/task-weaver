import assert from 'node:assert/strict'
import test from 'node:test'
import { startThinWake } from './thin-worker-wake.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
test('SSE hints coalesce and reconnects request another queue check', async () => {
  let connections = 0
  const fetcher: typeof fetch = async (_url, options) => {
    connections++
    const first = connections === 1
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connec'))
        controller.enqueue(new TextEncoder().encode('ted\ndata: {}\n\nevent: task_created\ndata: {}\n\nevent: task_created\ndata: {}\n\n'))
        if (first) setTimeout(() => controller.close(), 40)
        else options?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
      },
    }))
  }
  const stream = startThinWake({ apiUrl: 'http://fixture', apiKey: 'fixture', projectId: 'project', fetch: fetcher, reconnectMinMs: 20, reconnectMaxMs: 40 })
  try {
    await wait(10)
    await stream.wait(200)
    const before = Date.now(); await stream.wait(15); assert.ok(Date.now() - before >= 10, 'duplicate hints should be coalesced')
    await stream.wait(500)
    assert.ok(connections >= 2, 'reconnect should trigger a fresh query')
  } finally { await stream.close() }
})

test('missed events and stream failures fall back to polling', async () => {
  const stream = startThinWake({ apiUrl: 'http://fixture', apiKey: 'fixture', projectId: 'project', fetch: async () => { throw new Error('offline') }, reconnectMinMs: 20, reconnectMaxMs: 40 })
  try { const before = Date.now(); await stream.wait(45); assert.ok(Date.now() - before >= 35) } finally { await stream.close() }
})

test('revoked stream credentials stop the resident worker', async () => {
  const stream = startThinWake({ apiUrl: 'http://fixture', apiKey: 'fixture', projectId: 'project', fetch: async () => new Response(null, { status: 401 }) })
  try { await assert.rejects(stream.wait(200), /event access failed/) } finally { await stream.close() }
})
