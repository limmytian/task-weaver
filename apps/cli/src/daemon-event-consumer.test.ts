import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createDaemonEventConsumer } from './daemon-event-consumer.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('replays from checkpoint, retries uncertain acknowledgement, and closes', async () => {
  let checkpoint = '0', attempts = 0, handled = 0, reads = 0
  const consumer = createDaemonEventConsumer({ projectId: 'p', consumer: 'd', intervalMs: 100000,
    get: async <T>(path: string) => { reads++; return (path.includes('checkpoint') ? { cursor: checkpoint } : { status: 'valid', cursor: '1', retentionFloor: '0', events: checkpoint === '0' ? [{ sequence: '1' }] : [] }) as T },
    post: async <T>() => { if (++attempts === 1) throw new Error('disconnected'); checkpoint = '1'; return { status: 'valid', cursor: '1' } as T },
    handle: async events => { handled += events.length }, report: () => {},
  })
  await settle(); await consumer.tick(); await settle()
  assert.equal(handled, 2); assert.equal(checkpoint, '1'); assert.equal(attempts, 2)
  consumer.close(); const before = reads; await consumer.tick(); assert.equal(reads, before)
})

test('expired cursor stops replay and never acknowledges', async () => {
  let calls = 0, acknowledgments = 0; const reports: string[] = []
  const consumer = createDaemonEventConsumer({ projectId: 'p', consumer: 'd', intervalMs: 100000,
    get: async <T>(path: string) => { calls++; return (path.includes('checkpoint') ? { cursor: '0' } : { status: 'expired', cursor: '0', retentionFloor: '4' }) as T },
    post: async <T>() => { acknowledgments++; return {} as T }, handle: async () => {}, report: message => reports.push(message),
  })
  await settle(); await consumer.tick(); assert.equal(calls, 2); assert.equal(acknowledgments, 0); assert.match(reports[0]!, /expired/); consumer.close()
})

test('revoked parent cannot handle or acknowledge events', async () => {
  let handled = 0, ack = 0; const reports: string[] = []
  const consumer = createDaemonEventConsumer({ projectId: 'p', consumer: 'd', intervalMs: 100000,
    get: async () => { throw new Error('403 revoked') }, post: async <T>() => { ack++; return {} as T },
    handle: async () => { handled++ }, report: message => reports.push(message),
  })
  await settle(); consumer.close(); assert.equal(handled, 0); assert.equal(ack, 0); assert.match(reports[0]!, /revoked/)
})
