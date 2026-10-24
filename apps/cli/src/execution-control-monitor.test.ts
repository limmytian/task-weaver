import assert from 'node:assert/strict'
import test from 'node:test'
import { monitorExecutionControl, type ExecutionControl } from './execution-control-monitor.js'

test('durable reconciliation ignores other runs, deduplicates and stops despite lost acknowledgments', async () => {
  let rows: ExecutionControl[] = [{ id: 'other', runId: 'other-run', revision: 2, phase: 'pending', reason: 'edit', deadline: '' }]
  const phases: string[] = []
  let stops = 0
  const monitor = monitorExecutionControl({ runId: 'current', list: async () => rows,
    acknowledge: async (_control, phase) => { phases.push(phase); throw new Error('lost reply') }, stop: () => { stops++ }, intervalMs: 100000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stops, 0)
  rows = [...rows, { id: 'change', runId: 'current', revision: 9, phase: 'pending', reason: 'latest coalesced change', deadline: '' }]
  await monitor.tick(); await monitor.tick()
  assert.equal(stops, 1)
  assert.deepEqual(phases, ['received', 'stopping'])
  monitor.close()
})

test('poll failure and lost notification are recovered by the next authoritative read', async () => {
  let failed = true
  let stops = 0
  const monitor = monitorExecutionControl({ runId: 'run', list: async () => { if (failed) throw new Error('offline'); return [{ id: 'id', runId: 'run', revision: 7, phase: 'stopping', reason: 'edit', deadline: '' }] }, acknowledge: async () => {}, stop: () => { stops++ }, intervalMs: 100000 })
  await new Promise(resolve => setImmediate(resolve))
  failed = false
  await monitor.tick()
  assert.equal(stops, 1)
  monitor.close()
})
