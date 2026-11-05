import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createDaemonEventConsumer } from './daemon-event-consumer.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function server() {
  let owner = '', generation = 0, live = false, checkpoint = '0'
  let revoked = false, expired = false
  const acknowledgments: string[] = []
  return {
    acknowledgments,
    expireLease() { live = false },
    revoke() { revoked = true },
    expireCursor() { expired = true },
    get checkpoint() { return checkpoint },
    get: async <T>(path: string): Promise<T> => {
      if (revoked) throw new Error('403 revoked')
      return (path.includes('checkpoint') ? { cursor: checkpoint } : expired
        ? { status: 'expired', cursor: checkpoint, retentionFloor: '2' }
        : { status: 'valid', cursor: '1', retentionFloor: '0', events: checkpoint === '0' ? [{ sequence: '1' }] : [] }) as T
    },
    post: async <T>(path: string, body: unknown): Promise<T> => {
      if (revoked) throw new Error('403 revoked')
      const input = body as { owner: string; generation: string; cursor: string }
      if (path.endsWith('/acquire')) {
        if (live) return { status: 'busy' } as T
        owner = input.owner; live = true; generation++
        return { status: 'acquired', generation: String(generation) } as T
      }
      if (!live || owner !== input.owner || String(generation) !== input.generation) throw new Error('stale lease')
      if (path.endsWith('/renew')) return { generation: String(generation) } as T
      if (path.endsWith('/incidents')) return {} as T
      assert.ok(path.endsWith('/ack/fenced'))
      checkpoint = input.cursor; acknowledgments.push(input.owner)
      return { status: 'valid', cursor: checkpoint, retentionFloor: '0' } as T
    },
  }
}

test('competing instances, restart takeover and stale owner are fenced', async () => {
  const api = server(); let firstHandled = 0, secondHandled = 0
  let release!: () => void
  const first = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...api, intervalMs: 100000,
    handle: async events => { if (events.length) { firstHandled++; await new Promise<void>(resolve => { release = resolve }) } }, report: () => {} })
  await settle()
  const second = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...api, intervalMs: 100000,
    handle: async events => { secondHandled += events.length }, report: () => {} })
  await settle(); assert.equal(secondHandled, 0)
  api.expireLease(); await second.tick(); assert.equal(secondHandled, 1); assert.equal(api.checkpoint, '1')
  release(); await settle(); assert.equal(firstHandled, 1); assert.equal(api.acknowledgments.length, 1)
  first.close(); second.close()
  api.expireLease()
  const restarted = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...api, intervalMs: 100000,
    handle: async events => { secondHandled += events.length }, report: () => {} })
  await settle(); assert.equal(secondHandled, 1); restarted.close()
})

test('failed handling and revocation never acknowledge; reconnect replays', async () => {
  const api = server(); let handled = 0
  const consumer = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...api, intervalMs: 100000,
    handle: async events => { if (events.length && ++handled === 1) throw new Error('failed') }, report: () => {} })
  await settle(); assert.equal(api.acknowledgments.length, 0)
  await consumer.tick(); assert.equal(handled, 2); assert.equal(api.acknowledgments.length, 1)
  api.revoke(); await consumer.tick(); assert.equal(api.acknowledgments.length, 1)
  consumer.close()
})

test('expired cursor and close during replay prevent acknowledgment', async () => {
  const api = server(); api.expireCursor(); const reports: string[] = []
  const consumer = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...api, intervalMs: 100000,
    handle: async () => assert.fail('expired'), report: message => reports.push(message) })
  await settle(); await consumer.tick(); assert.match(reports[0]!, /expired/); assert.equal(api.acknowledgments.length, 0); consumer.close()
  const other = server(); let resolve!: (value: unknown) => void; let handled = 0
  const closing = createDaemonEventConsumer({ projectId: 'p', consumer: 'node', ...other, intervalMs: 100000,
    get: async <T>(path: string) => path.includes('checkpoint') ? { cursor: '0' } as T : await new Promise<T>(r => { resolve = r as (value: unknown) => void }),
    handle: async () => { handled++ }, report: () => {} })
  await settle(); closing.close(); resolve({ status: 'valid', cursor: '1', retentionFloor: '0', events: [{}] }); await settle()
  assert.equal(handled, 0); assert.equal(other.acknowledgments.length, 0)
})
