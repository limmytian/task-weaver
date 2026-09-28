import assert from 'node:assert/strict'
import test from 'node:test'
import { runCommand } from './async-command.js'
import { DaemonLifecycle, cancellationReason } from './daemon-lifecycle.js'
import { LeaseSupervisor } from './lease-supervisor.js'

function finishOnAbort(operation: ReturnType<DaemonLifecycle['start']>, delayMs = 0) {
  operation.signal.addEventListener('abort', () => {
    setTimeout(operation.complete, delayMs)
  }, { once: true })
}

test('daemon drain cancels every lane and waits for deterministic cleanup', async () => {
  const lifecycle = new DaemonLifecycle()
  const first = lifecycle.start('0')
  const second = lifecycle.start('1')
  finishOnAbort(first, 15)
  finishOnAbort(second, 5)

  const drain = lifecycle.drain('SIGINT')
  assert.equal(lifecycle.phase, 'draining')
  assert.equal(cancellationReason(first.signal), 'SIGINT')
  assert.equal(cancellationReason(second.signal), 'SIGINT')
  assert.equal(lifecycle.activeOperations, 2)

  await drain
  assert.equal(lifecycle.phase, 'stopped')
  assert.equal(lifecycle.activeOperations, 0)
  assert.throws(() => lifecycle.start('2'), /draining/)
})

test('parallel child operations overlap while lease heartbeats remain responsive', async () => {
  const lifecycle = new DaemonLifecycle()
  let processHeartbeats = 0
  let laneHeartbeats = 0
  const supervisor = new LeaseSupervisor({
    intervalMs: 10,
    heartbeatProcess: async () => { processHeartbeats += 1 },
    heartbeatLease: async () => { laneHeartbeats += 1 },
  })
  supervisor.register({ key: '0', requirementId: 'req-0', generation: 1 })
  supervisor.register({ key: '1', requirementId: 'req-1', generation: 1 })
  supervisor.start()

  const windows = new Map<string, { readyAt: number; completedAt: number }>()
  const operations = ['0', '1'].map(async (key) => {
    const operation = lifecycle.start(key)
    try {
      const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 300)'], {
        signal: operation.signal,
        timeoutMs: 2_000,
        onOutput: ({ chunk }) => {
          if (chunk.includes('ready')) windows.set(key, { readyAt: Date.now(), completedAt: 0 })
        },
      })
      windows.get(key)!.completedAt = Date.now()
      return result
    } finally {
      operation.complete()
    }
  })
  const results = await Promise.all(operations)
  supervisor.stop()
  lifecycle.stop()

  assert.ok(results.every((result) => result.ok))
  const overlapMs = Math.min(...[...windows.values()].map((window) => window.completedAt))
    - Math.max(...[...windows.values()].map((window) => window.readyAt))
  assert.ok(overlapMs >= 150, `expected measurable child-process overlap, saw ${overlapMs}ms`)
  assert.ok(processHeartbeats >= 3, `expected process heartbeats, saw ${processHeartbeats}`)
  assert.ok(laneHeartbeats >= 6, `expected per-lane heartbeats, saw ${laneHeartbeats}`)
})

test('child spawn errors resolve as retryable results instead of crashing the daemon', async () => {
  const result = await runCommand('task-weaver-command-that-does-not-exist', [], {
    timeoutMs: 1_000,
  })

  assert.equal(result.ok, false)
  assert.notEqual(result.status, 0)
  assert.equal(result.errorCode, 'ENOENT')
  assert.match(result.stderr, /ENOENT/)
})
