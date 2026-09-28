import assert from 'node:assert'
import { test } from 'node:test'
import {
  finalizeRequirementBranch,
  type CommandRunner,
  type ShellResult,
} from './daemon-finalization.js'

const requirement = {
  id: 'req-1',
  title: 'Finalize daemon branch',
}

function result(overrides: Partial<ShellResult> = {}): ShellResult {
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
    if (!removed) {
      throw new Error(`Missing fake response for command: ${key}`)
    }
    const [, response] = removed
    return result({ command: key, ...response })
  }
  return { calls, run }
}

function firstComment(comments: Array<{ taskId: string; content: string }>): string {
  assert.equal(comments.length, 1)
  return comments[0]!.content
}

async function finalizeWith(
  responses: Array<[string, Partial<ShellResult>]>,
): Promise<{
  calls: string[]
  comments: Array<{ taskId: string; content: string }>
  finalization: Awaited<ReturnType<typeof finalizeRequirementBranch>>
}> {
  const { calls, run } = createRunner(responses)
  const comments: Array<{ taskId: string; content: string }> = []
  const finalization = await finalizeRequirementBranch({
    requirement,
    branchName: 'req/finalize-daemon',
    worktreePath: '/tmp/worktree',
    commentTaskId: 'task-1',
    run,
    addTaskComment: async (taskId, content) => {
      comments.push({ taskId, content })
    },
  })
  return { calls, comments, finalization }
}

test('finalization skips commit when there are no changes and records missing gh', async () => {
  const { calls, comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: '' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
    ['git push -u origin req/finalize-daemon', {}],
    ['gh --version', { ok: false, status: null, stderr: 'spawn gh ENOENT' }],
  ])

  assert.equal(finalization.commitCreated, false)
  assert.equal(finalization.commitSha, 'abc1234')
  assert.equal(finalization.pushSucceeded, true)
  assert.equal(finalization.prUrl, null)
  assert.equal(calls.some((call) => call.startsWith('git commit')), false)
  const comment = firstComment(comments)
  assert.match(comment, /no local file changes/i)
  assert.match(comment, /gh CLI unavailable/)
})

test('finalization reuses an existing PR after publishing the branch', async () => {
  const { calls, comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: '' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
    ['git push -u origin req/finalize-daemon', {}],
    ['gh --version', { stdout: 'gh version 2.0.0' }],
    ['gh pr view req/finalize-daemon', { stdout: 'https://example.test/pr/12' }],
  ])

  assert.equal(finalization.prUrl, 'https://example.test/pr/12')
  assert.equal(calls.some((call) => call.startsWith('gh pr create')), false)
  assert.match(firstComment(comments), /existing PR found/)
})

test('finalization creates a PR when no existing PR is found', async () => {
  const { calls, comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: '' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
    ['git push -u origin req/finalize-daemon', {}],
    ['gh --version', { stdout: 'gh version 2.0.0' }],
    ['gh pr view req/finalize-daemon', { ok: false, status: 1, stderr: 'no pull requests found' }],
    ['gh pr create', { stdout: 'https://example.test/pr/13' }],
  ])

  assert.equal(finalization.prUrl, 'https://example.test/pr/13')
  assert.equal(calls.some((call) => call.startsWith('gh pr create')), true)
  assert.match(firstComment(comments), /PR: created/)
})

test('finalization handles PR create races by viewing the PR again', async () => {
  const { comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: '' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
    ['git push -u origin req/finalize-daemon', {}],
    ['gh --version', { stdout: 'gh version 2.0.0' }],
    ['gh pr view req/finalize-daemon', { ok: false, status: 1, stderr: 'no pull requests found' }],
    ['gh pr create', { ok: false, status: 1, stderr: 'a pull request already exists' }],
    ['gh pr view req/finalize-daemon', { stdout: 'https://example.test/pr/14' }],
  ])

  assert.equal(finalization.prUrl, 'https://example.test/pr/14')
  assert.match(firstComment(comments), /found after create retry/)
})

test('finalization records push failure and skips PR handling', async () => {
  const { calls, comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: ' M file.ts' }],
    ['git add -A', {}],
    ['git diff --cached --quiet', { ok: false, status: 1 }],
    ['git commit', { stdout: '[req/finalize-daemon abc1234] feat' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
    ['git push -u origin req/finalize-daemon', { ok: false, status: 1, stderr: 'push rejected' }],
  ])

  assert.equal(finalization.commitCreated, true)
  assert.equal(finalization.pushSucceeded, false)
  assert.equal(calls.some((call) => call.startsWith('gh ')), false)
  const comment = firstComment(comments)
  assert.match(comment, /Push: failed/)
  assert.match(comment, /push rejected/)
})

test('finalization skips push when dirty worktree changes cannot be committed', async () => {
  const { calls, comments, finalization } = await finalizeWith([
    ['git status --porcelain', { stdout: ' M file.ts' }],
    ['git add -A', {}],
    ['git diff --cached --quiet', { ok: false, status: 1 }],
    ['git commit', { ok: false, status: 128, stderr: 'Author identity unknown' }],
    ['git rev-parse --short HEAD', { stdout: 'abc1234' }],
  ])

  assert.equal(finalization.commitCreated, false)
  assert.equal(finalization.pushSucceeded, false)
  assert.equal(calls.some((call) => call.startsWith('git push')), false)
  const comment = firstComment(comments)
  assert.match(comment, /Commit: failed/)
  assert.match(comment, /Push: skipped/)
})
