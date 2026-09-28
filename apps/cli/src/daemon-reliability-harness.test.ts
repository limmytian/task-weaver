import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeRequirementBranch } from './daemon-review.js'
import {
  AcceleratedLeaseRegistry,
  DeterministicFaultInjector,
  InjectedFaultError,
  runAcceleratedLeaseSoak,
  type ReliabilityBoundary,
} from './daemon-reliability-harness.js'

test('accelerated multi-role soak fences transient heartbeat loss without duplicate or stranded lanes', async () => {
  const iterations = Number(process.env.TW_DAEMON_SOAK_ITERATIONS) || 21_600
  const result = await runAcceleratedLeaseSoak({ iterations })
  assert.equal(result.virtualDurationMs, iterations * 1_000)
  assert.ok(result.acquisitions > 4)
  assert.ok(result.acceptedWrites > iterations)
  assert.ok(result.heartbeatFaults > 0)
  assert.ok(result.fencedWrites > 0)
  assert.ok(result.recoveries > 0)
  assert.equal(result.duplicateLaneOwners, 0)
  assert.equal(result.strandedLanes, 0)
})

test('high-contention acquisition and reassignment reject duplicate and stale generations', async () => {
  const registry = new AcceleratedLeaseRegistry(100)
  const attempts = await Promise.all(Array.from({ length: 64 }, (_, index) =>
    Promise.resolve().then(() => registry.acquire('shared-lane', `worker-${index}`)),
  ))
  const winners = attempts.filter((token) => token !== null)
  assert.equal(winners.length, 1)
  const first = winners[0]!
  assert.equal(registry.mutate(first), true)

  registry.advance(101)
  const next = registry.acquire('shared-lane', 'replacement-worker')
  assert.ok(next)
  assert.ok(next.generation > first.generation)
  assert.equal(registry.mutate(first), false)
  assert.equal(registry.mutate(next), true)
})

test('every external boundary supports deterministic before-effect and response-loss injection', async () => {
  const boundaries: ReliabilityBoundary[] = ['api', 'database', 'git', 'credential', 'ai', 'check', 'forge']
  for (const boundary of boundaries) {
    let sideEffects = 0
    const beforeRetry = boundary === 'credential' ? 'manual' as const : 'automatic' as const
    const before = new DeterministicFaultInjector([{
      boundary, timing: 'before', attempts: [1], failureCode: `${boundary}_unavailable`, retry: beforeRetry,
    }])
    await assert.rejects(
      () => before.invoke(boundary, () => { sideEffects += 1 }),
      (error: unknown) => error instanceof InjectedFaultError
        && error.failureCode === `${boundary}_unavailable`
        && error.retry === beforeRetry,
    )
    assert.equal(sideEffects, 0)

    const completed = new Map<string, number>()
    const responseLoss = new DeterministicFaultInjector([{
      boundary, timing: 'after', attempts: [1], failureCode: `${boundary}_response_lost`, retry: 'automatic',
    }])
    const idempotentEffect = () => {
      if (!completed.has(boundary)) {
        sideEffects += 1
        completed.set(boundary, sideEffects)
      }
      return completed.get(boundary)!
    }
    await assert.rejects(() => responseLoss.invoke(boundary, idempotentEffect), InjectedFaultError)
    const retried = await responseLoss.invoke(boundary, idempotentEffect)
    assert.equal(retried, completed.get(boundary))
    assert.equal(sideEffects, 1)
  }
})

test('base publication races refresh once and remain bounded', async () => {
  let pushes = 0
  const result = await mergeRequirementBranch({
    requirement: { id: 'requirement-1', projectId: 'project-1', title: 'Race test' },
    branchName: 'req/race',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: null,
    run: async (command, args) => {
      const rendered = [command, ...args].join(' ')
      if (args[0] === 'push') {
        pushes += 1
        if (pushes === 1) {
          return { ok: false, status: 1, stdout: '', stderr: 'rejected non-fast-forward', command: rendered }
        }
      }
      return { ok: true, status: 0, stdout: '', stderr: '', command: rendered }
    },
  })
  assert.equal(result.status, 'merged')
  assert.equal(pushes, 2)
})
