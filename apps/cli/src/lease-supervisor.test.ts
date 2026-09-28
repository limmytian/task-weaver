import assert from 'node:assert/strict'
import test from 'node:test'
import { LeaseSupervisor, LeaseUncertainError } from './lease-supervisor.js'

test('lease supervisor records failures and fences mutations until renewal succeeds', async () => {
  let failLease = true
  const snapshots: boolean[] = []
  const supervisor = new LeaseSupervisor({
    heartbeatProcess: async () => undefined,
    heartbeatLease: async () => {
      if (failLease) throw new Error('network uncertain')
    },
    onHealthChange: (snapshot) => snapshots.push(snapshot.healthy),
  })
  supervisor.register({ key: '0', requirementId: 'req-1', generation: 7 })

  await supervisor.tick()
  assert.throws(() => supervisor.assertHealthy('0'), LeaseUncertainError)
  assert.equal(supervisor.snapshot('0')?.heartbeatFailures, 1)
  assert.match(supervisor.snapshot('0')?.lastError ?? '', /network uncertain/)

  failLease = false
  await supervisor.tick()
  assert.equal(supervisor.assertHealthy('0').generation, 7)
  assert.deepEqual(snapshots.slice(-2), [false, true])
})

test('process heartbeat uncertainty fences every registered lane independently of lane renewal', async () => {
  const supervisor = new LeaseSupervisor({
    heartbeatProcess: async () => { throw new Error('process heartbeat failed') },
    heartbeatLease: async () => undefined,
  })
  supervisor.register({ key: '0', requirementId: 'req-1', generation: 1 })
  supervisor.register({ key: '1', requirementId: 'req-2', generation: 2 })

  await supervisor.tick()
  assert.equal(supervisor.snapshot('0')?.healthy, false)
  assert.equal(supervisor.snapshot('1')?.healthy, false)
})
