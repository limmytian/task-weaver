import assert from 'node:assert'
import { test } from 'node:test'
import {
  mergeRequirementBranch,
  parseReviewDecision,
  reviewRequirementBranch,
  type ReviewDecision,
} from './daemon-review.js'
import type { CommandRunner, ShellResult } from './daemon-finalization.js'

const requirement = {
  id: 'req-review',
  projectId: 'project-1',
  title: 'Review daemon lane',
}

function shellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    ok: true,
    status: 0,
    stdout: '',
    stderr: '',
    command: 'test command',
    ...overrides,
  }
}

function createRunner(responses: Array<[string, Partial<ShellResult>]>): {
  calls: string[]
  run: CommandRunner
} {
  const calls: string[] = []
  const run: CommandRunner = (command, args) => {
    const key = [command, ...args].join(' ')
    calls.push(key)
    const index = responses.findIndex(([prefix]) => key.startsWith(prefix))
    if (index === -1) {
      throw new Error(`Unexpected command: ${key}`)
    }
    const removed = responses.splice(index, 1)[0]
    if (!removed) throw new Error(`Missing fake response for command: ${key}`)
    const [, response] = removed
    return shellResult({ command: key, ...response })
  }
  return { calls, run }
}

function callbacks() {
  const comments: string[] = []
  const tasks: Array<{ title: string; description: string }> = []
  const statuses: string[] = []
  return {
    comments,
    tasks,
    statuses,
    addTaskComment: async (_taskId: string, content: string) => {
      comments.push(content)
    },
    createFollowupTask: async (input: { title: string; description: string }) => {
      tasks.push(input)
    },
    updateRequirementStatus: async (status: 'in_progress' | 'done' | 'in_review' | 'ready_to_merge') => {
      statuses.push(status)
    },
  }
}

test('reviewRequirementBranch marks approved branches ready to merge', async () => {
  const { run, calls } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', {}],
    ['git push origin req/review', {}],
  ])
  const cb = callbacks()

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    run,
    runAiReview: async (): Promise<ReviewDecision> => ({ approved: true, summary: 'REVIEW_DECISION: approve' }),
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'approved')
  assert.equal(cb.statuses.at(-1), 'ready_to_merge')
  assert.equal(cb.tasks.length, 0)
  assert.ok(!calls.some((call) => call === 'git push origin HEAD:main'))
  assert.match(cb.comments[0] ?? '', /ready_to_merge/)
})

test('reviewRequirementBranch emits structured audit callbacks for the exact reviewed commit', async () => {
  const { run } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', {}],
    ['git push origin req/review', {}],
    ['git rev-parse HEAD', { stdout: 'head123456789\n' }],
    ['git rev-parse origin/main', { stdout: 'base123456789\n' }],
  ])
  const prepared: Array<{ headCommit: string; baseCommit: string }> = []
  const checkResults: string[] = []
  const aiDecisions: ReviewDecision[] = []

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: null,
    checks: ['pnpm typecheck'],
    run,
    runCheck: async (command) => shellResult({ command, stdout: 'passed' }),
    runAiReview: async () => ({ approved: true, summary: 'REVIEW_DECISION: approve' }),
    onPrepared: async (input) => { prepared.push(input) },
    onCheckResult: async ({ name }) => { checkResults.push(name) },
    onAiDecision: async (decision) => { aiDecisions.push(decision) },
  })

  assert.equal(result.status, 'approved')
  assert.deepEqual(prepared, [{ headCommit: 'head123456789', baseCommit: 'base123456789' }])
  assert.deepEqual(checkResults, ['pnpm typecheck'])
  assert.deepEqual(aiDecisions, [{ approved: true, summary: 'REVIEW_DECISION: approve' }])
})

test('reviewRequirementBranch fails closed before Git when no review policy is available', async () => {
  const cb = callbacks()
  const calls: string[] = []

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    run: (command, args) => {
      calls.push([command, ...args].join(' '))
      return shellResult()
    },
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'skipped')
  assert.equal(result.outcomeCode, 'review_policy_unavailable')
  assert.equal(result.reviewPolicyDecision, 'blocked')
  assert.deepEqual(result.reviewPolicyEvidence, [])
  assert.deepEqual(calls, [])
  assert.equal(cb.statuses.at(-1), 'in_review')
  assert.equal(cb.tasks.length, 0)
  assert.match(cb.comments[0] ?? '', /remains in_review/)
})

test('reviewRequirementBranch audits an explicit unsafe review bypass', async () => {
  const { run } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', {}],
    ['git push origin req/review', {}],
  ])
  const cb = callbacks()

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    run,
    allowUnreviewed: true,
    addTaskComment: cb.addTaskComment,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'approved')
  assert.equal(result.outcomeCode, 'review_policy_bypassed')
  assert.equal(result.reviewPolicyDecision, 'bypassed')
  assert.deepEqual(result.reviewPolicyEvidence, [])
  assert.equal(cb.statuses.at(-1), 'ready_to_merge')
  assert.match(cb.comments[0] ?? '', /UNSAFE BYPASS/)
})

test('mergeRequirementBranch merges reviewed branches', async () => {
  const { run, calls } = createRunner([
    ['git fetch origin', {}],
    ['git reset --hard origin/main', {}],
    ['git clean -fd', {}],
    ['git merge --no-ff --no-edit origin/req/review', {}],
    ['git push origin HEAD:main', {}],
  ])
  const cb = callbacks()

  const result = await mergeRequirementBranch({
    requirement,
    branchName: 'req/review',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: 'task-1',
    run,
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'merged')
  assert.equal(cb.statuses.at(-1), 'done')
  assert.equal(cb.tasks.length, 0)
  assert.ok(calls.some((call) => call === 'git push origin HEAD:main'))
  assert.match(cb.comments[0] ?? '', /Requirement status: moved to done/)
})

test('mergeRequirementBranch refreshes and retries a concurrent base update once', async () => {
  const { run, calls } = createRunner([
    ['git fetch origin', {}],
    ['git reset --hard origin/main', {}],
    ['git clean -fd', {}],
    ['git merge --no-ff --no-edit origin/req/review', {}],
    ['git push origin HEAD:main', { ok: false, status: 1, stderr: 'rejected (non-fast-forward)' }],
    ['git fetch origin', {}],
    ['git reset --hard origin/main', {}],
    ['git clean -fd', {}],
    ['git merge --no-ff --no-edit origin/req/review', {}],
    ['git push origin HEAD:main', {}],
  ])
  const cb = callbacks()

  const result = await mergeRequirementBranch({
    requirement,
    branchName: 'req/review',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: 'task-1',
    run,
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'merged')
  assert.equal(calls.filter((call) => call === 'git fetch origin').length, 2)
  assert.equal(calls.filter((call) => call === 'git push origin HEAD:main').length, 2)
  assert.equal(cb.tasks.length, 0)
  assert.match(cb.comments[0] ?? '', /refreshing and retrying/)
})

test('mergeRequirementBranch bounds repeated non-fast-forward publication races', async () => {
  const { run } = createRunner([
    ['git fetch origin', {}],
    ['git reset --hard origin/main', {}],
    ['git clean -fd', {}],
    ['git merge --no-ff --no-edit origin/req/review', {}],
    ['git push origin HEAD:main', { ok: false, status: 1, stderr: 'rejected (non-fast-forward)' }],
    ['git fetch origin', {}],
    ['git reset --hard origin/main', {}],
    ['git clean -fd', {}],
    ['git merge --no-ff --no-edit origin/req/review', {}],
    ['git push origin HEAD:main', { ok: false, status: 1, stderr: 'rejected (non-fast-forward)' }],
  ])
  const cb = callbacks()

  const result = await mergeRequirementBranch({
    requirement,
    branchName: 'req/review',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: 'task-1',
    run,
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.outcomeCode, 'merge_base_update_retry_exhausted')
  assert.equal(cb.tasks.length, 0)
  assert.deepEqual(cb.statuses, [])
})

test('reviewRequirementBranch routes base merge conflicts back to work', async () => {
  const { run } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', { ok: false, status: 1, stderr: 'conflict' }],
    ['git merge --abort', {}],
  ])
  const cb = callbacks()

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    checks: ['pnpm test'],
    run,
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'conflict')
  assert.equal(result.outcomeCode, 'review_conflict')
  assert.equal(cb.statuses.at(-1), 'in_progress')
  assert.match(cb.tasks[0]?.title ?? '', /Resolve merge conflicts/)
  assert.match(cb.comments[0] ?? '', /conflict resolution/)
})

test('reviewRequirementBranch routes failed checks back to work', async () => {
  const { run } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', {}],
    ['git push origin req/review', {}],
  ])
  const cb = callbacks()

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    checks: ['pnpm test'],
    run,
    runCheck: () => shellResult({ ok: false, status: 1, stderr: 'test failed' }),
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'changes_requested')
  assert.equal(result.outcomeCode, 'review_check_failed')
  assert.equal(cb.statuses.at(-1), 'in_progress')
  assert.match(cb.tasks[0]?.title ?? '', /Fix review check failure/)
  assert.match(cb.comments[0] ?? '', /test failed/)
})

test('reviewRequirementBranch routes AI review findings back to work', async () => {
  const { run } = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', {}],
    ['git checkout req/review', {}],
    ['git merge --no-ff --no-edit origin/main', {}],
    ['git push origin req/review', {}],
  ])
  const cb = callbacks()

  const result = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: 'task-1',
    run,
    runAiReview: async () => ({ approved: false, summary: 'REVIEW_DECISION: changes_requested\nBug found.' }),
    addTaskComment: cb.addTaskComment,
    createFollowupTask: cb.createFollowupTask,
    updateRequirementStatus: cb.updateRequirementStatus,
  })

  assert.equal(result.status, 'changes_requested')
  assert.equal(result.outcomeCode, 'ai_review_changes_requested')
  assert.equal(cb.statuses.at(-1), 'in_progress')
  assert.match(cb.tasks[0]?.title ?? '', /Address review feedback/)
  assert.match(cb.comments[0] ?? '', /Bug found/)
})

test('parseReviewDecision recognizes approve and defaults to changes requested', () => {
  assert.equal(parseReviewDecision('Looks good\nREVIEW_DECISION: approve').approved, true)
  assert.equal(parseReviewDecision('No decision').approved, false)
})

test('review and merge infrastructure failures expose normalized outcome codes', async () => {
  const reviewRunner = createRunner([
    ['git status --porcelain', {}],
    ['git fetch origin', { ok: false, status: 1, stderr: 'network unavailable' }],
  ])
  const review = await reviewRequirementBranch({
    requirement,
    branchName: 'req/review',
    worktreePath: '/tmp/branch',
    commentTaskId: null,
    checks: ['pnpm test'],
    run: reviewRunner.run,
  })
  assert.equal(review.status, 'failed')
  assert.equal(review.outcomeCode, 'git_fetch_failed')

  const mergeRunner = createRunner([
    ['git fetch origin', {}],
    ['git reset --hard origin/main', { ok: false, status: 1, stderr: 'reset failed' }],
  ])
  const merge = await mergeRequirementBranch({
    requirement,
    branchName: 'req/review',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: null,
    run: mergeRunner.run,
  })
  assert.equal(merge.status, 'failed')
  assert.equal(merge.outcomeCode, 'git_reset_failed')
})
