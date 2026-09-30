import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyDaemonQueueRequirement,
  type DaemonQueueRequirementInput,
} from './daemon-control-plane'
import {
  classifyDaemonOutcome,
  daemonRoleForPhase,
  planRepositoryRetry,
} from './daemon-state-machine'
import type { DaemonPhase } from "@task-weaver/contracts"

const now = new Date('2026-07-24T08:00:00.000Z')
const daemons = [
  { role: 'executor' as const, capabilities: ['executor:codex'] },
  { role: 'reviewer' as const, capabilities: ['review'] },
  { role: 'merger' as const, capabilities: ['merge'] },
]

const faults: Array<{
  boundary: string
  code: string
  phase: Extract<DaemonPhase, 'execution' | 'review' | 'merge'>
  retry: 'automatic' | 'manual'
}> = [
  { boundary: 'api', code: 'api_unavailable', phase: 'execution', retry: 'automatic' },
  { boundary: 'database', code: 'database_unavailable', phase: 'execution', retry: 'automatic' },
  { boundary: 'git', code: 'git_push_failed', phase: 'execution', retry: 'automatic' },
  { boundary: 'credential', code: 'credential_unavailable', phase: 'execution', retry: 'manual' },
  { boundary: 'ai', code: 'ai_timeout', phase: 'execution', retry: 'automatic' },
  { boundary: 'check', code: 'check_timeout', phase: 'review', retry: 'automatic' },
  { boundary: 'forge', code: 'forge_unavailable', phase: 'merge', retry: 'automatic' },
];

function requirementFor(fault: typeof faults[number], input: {
  retryPolicy: 'automatic' | 'manual'
  nextAttemptAt?: string | null
}): DaemonQueueRequirementInput {
  const status = fault.phase === 'review' ? 'in_review' : fault.phase === 'merge' ? 'ready_to_merge' : 'in_progress'
  const role = daemonRoleForPhase(fault.phase)
  return {
    id: `requirement-${fault.boundary}`,
    projectId: 'project-1',
    projectName: 'Task Weaver',
    title: `${fault.boundary} fault`,
    status,
    priority: 'high',
    updatedAt: now,
    tasks: fault.phase === 'execution' ? [{
      id: `task-${fault.boundary}`,
      title: 'Retry faulted operation',
      status: 'todo',
      tags: ['executor:codex'],
      dependencies: [],
    }] : [],
    executionSlices: [],
    dependencies: [],
    repositories: [{
      id: `link-${fault.boundary}`,
      repositoryId: 'repository-1',
      repositoryName: 'Task Weaver',
      repositoryKey: 'example/task-weaver',
      deliveryStatus: 'failed',
      failureCode: fault.code,
      failureSummary: `${fault.boundary} injected failure`,
      retryCount: 1,
      retryRole: role,
      retryPolicy: input.retryPolicy,
      retryPhase: fault.phase,
      nextAttemptAt: input.nextAttemptAt ?? null,
    }],
  }
}

test('all fault boundaries normalize to bounded retry or explicit operator action', () => {
  for (const fault of faults) {
    const outcome = classifyDaemonOutcome(fault.code, {
      currentPhase: fault.phase,
      operation: fault.boundary,
    })
    assert.equal(outcome.retryPolicy, fault.retry, `${fault.boundary} retry policy`)
    assert.equal(outcome.followUpTask, 'forbidden')
    assert.ok(outcome.operatorMessage.length > 20)
    const plan = planRepositoryRetry(outcome.retryPolicy, 1)
    assert.equal(plan.effectivePolicy, fault.retry)
    assert.equal(plan.delayMs === null, fault.retry === 'manual')
  }
})

test('lost responses after successful side effects remain automatic and bounded', () => {
  for (const boundary of faults.map((fault) => fault.boundary)) {
    const outcome = classifyDaemonOutcome(`${boundary}_response_lost`, {
      currentPhase: 'execution',
      operation: boundary,
    })
    assert.equal(outcome.category, 'infrastructure')
    assert.equal(outcome.retryPolicy, 'automatic')
    assert.match(outcome.operatorMessage, /bounded backoff/)
  }
  const exhausted = planRepositoryRetry('automatic', 8)
  assert.equal(exhausted.exhausted, true)
  assert.equal(exhausted.effectivePolicy, 'manual')
})

test('faulted lanes are always retrying, runnable when due, or manual—never dead', () => {
  for (const fault of faults) {
    if (fault.retry === 'manual') {
      const item = classifyDaemonQueueRequirement(
        requirementFor(fault, { retryPolicy: 'manual' }), daemons, now,
      )
      assert.equal(item?.state, 'manual')
      assert.ok(item?.reasons[0]?.includes('injected failure'))
      continue
    }
    const waiting = classifyDaemonQueueRequirement(requirementFor(fault, {
      retryPolicy: 'automatic',
      nextAttemptAt: '2026-07-24T08:05:00.000Z',
    }), daemons, now)
    assert.equal(waiting?.state, 'retrying', `${fault.boundary} waiting state`)

    const due = classifyDaemonQueueRequirement(requirementFor(fault, {
      retryPolicy: 'automatic',
      nextAttemptAt: '2026-07-24T07:59:00.000Z',
    }), daemons, now)
    assert.equal(due?.state, 'runnable', `${fault.boundary} due state`)
    assert.equal(due?.role, daemonRoleForPhase(fault.phase))
  }
})
