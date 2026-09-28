import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeRequirementBranch } from './daemon-review.js'
import { manualMergeActionUrl, selectMergeMode } from './daemon-merge-policy.js'
import {
  GenericGitAdapter,
  GiteaGitAdapter,
  GitHubGitAdapter,
  type GitCommandResult,
  type GitRunner,
} from './git-provider.js'
import type { CredentialResolution } from './repository-credentials.js'

const headCommit = 'abcdef123456'
const credential: CredentialResolution = {
  state: 'available',
  reasonCode: 'test_ready',
  transport: 'https',
  operation: 'forge',
  policyRevision: 1,
  checkedAt: '2026-07-24T00:00:00.000Z',
  trustedEnvironment: { PATH: '/usr/bin' },
  trustedGitConfig: [],
}

function commandResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return { ok: true, status: 0, stdout: '', stderr: '', ...overrides }
}

function commandRunner(responses: Array<[string, Partial<GitCommandResult>]>) {
  const calls: string[] = []
  const run: GitRunner = (command, args) => {
    const call = [command, ...args].join(' ')
    calls.push(call)
    const index = responses.findIndex(([needle]) => call.includes(needle))
    assert.notEqual(index, -1, `Unexpected provider command: ${call}`)
    return commandResult(responses.splice(index, 1)[0]![1])
  }
  return { calls, run }
}

async function providerEvidence(provider: 'github' | 'gitea') {
  const providerResponse = provider === 'github'
    ? JSON.stringify({
        number: 12,
        url: 'https://github.com/acme/app/pull/12',
        state: 'OPEN',
        headRefOid: headCommit,
        baseRefOid: 'base12345678',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        reviews: [{
          author: { login: 'alice' }, state: 'APPROVED',
          submittedAt: '2026-07-24T00:00:00Z', commit: { oid: headCommit },
        }],
      })
    : JSON.stringify([{
        index: 12,
        html_url: 'https://gitea.example/acme/app/pulls/12',
        state: 'open',
        head: { ref: 'req/change', sha: headCommit },
        base: { ref: 'main', sha: 'base12345678' },
        mergeable: true,
        statuses: [{ context: 'ci', status: 'success' }],
        reviews: [{ user: { login: 'alice' }, state: 'APPROVED', commit_id: headCommit }],
      }])
  const fake = commandRunner([[
    provider === 'github' ? 'gh pr view' : 'tea pulls list',
    { stdout: providerResponse },
  ]])
  const adapter = provider === 'github'
    ? new GitHubGitAdapter(fake.run)
    : new GiteaGitAdapter(fake.run)
  const found = await adapter.findPullRequest({
    worktreePath: '/tmp/repository',
    branchName: 'req/change',
    baseBranch: 'main',
    title: 'Review policy E2E',
    body: 'Automated delivery.',
    credential,
    repository: {
      host: provider === 'github' ? 'github.com' : 'gitea.example',
      namespace: 'acme',
      name: 'app',
    },
  })
  assert.equal(found.ok, true)
  if (!found.ok || !found.value) throw new Error(`${provider} did not return a pull request`)
  return found.value
}

test('GitHub and Gitea expose equivalent commit-fenced checks and human approvals', async () => {
  for (const provider of ['github', 'gitea'] as const) {
    const pullRequest = await providerEvidence(provider)
    assert.equal(pullRequest.headCommit, headCommit)
    assert.deepEqual(pullRequest.checks.map(({ name, state }) => ({ name, state })), [
      { name: 'ci', state: 'passed' },
    ])
    assert.deepEqual(pullRequest.approvals.map(({ actorId, state, headCommit: commit }) => ({
      actorId, state, headCommit: commit,
    })), [{ actorId: 'alice', state: 'approved', headCommit }])
  }
})

test('provider outage and generic Git fail closed without invented forge evidence', async () => {
  const outage = commandRunner([[
    'gh pr view',
    { ok: false, status: 1, stderr: 'network connection timed out' },
  ]])
  const unavailable = await new GitHubGitAdapter(outage.run).findPullRequest({
    worktreePath: '/tmp/repository', branchName: 'req/change', baseBranch: 'main',
    title: 'Review policy E2E', body: 'Automated delivery.', credential,
  })
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) {
    assert.equal(unavailable.failure.category, 'infrastructure')
    assert.equal(unavailable.failure.retry, 'automatic')
  }

  const unsupported = await new GenericGitAdapter().findPullRequest({
    worktreePath: '/tmp/repository', branchName: 'req/change', baseBranch: 'main',
    title: 'Review policy E2E', body: 'Automated delivery.', credential,
  })
  assert.equal(unsupported.ok, false)
  if (!unsupported.ok) assert.equal(unsupported.failure.code, 'forge_not_supported')
})

test('protected direct push and manual merge route to operator action without code rework', async () => {
  const calls: string[] = []
  const result = await mergeRequirementBranch({
    requirement: { id: 'requirement-1', projectId: 'project-1', title: 'Protected merge' },
    branchName: 'req/change',
    mergeWorktreePath: '/tmp/merge',
    commentTaskId: null,
    run: async (command, args) => {
      const call = [command, ...args].join(' ')
      calls.push(call)
      return args[0] === 'push'
        ? { ...commandResult({ ok: false, status: 1, stderr: 'protected branch requires approving review' }), command: call }
        : { ...commandResult(), command: call }
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.outcomeCode, 'branch_policy_rejected')
  assert.equal(calls.some((call) => call.includes('merge --abort')), false)

  const manualPolicy = {
    allowedMergeModes: ['manual'] as const,
    defaultMergeMode: 'manual' as const,
    baseBranch: 'main',
  }
  assert.equal(selectMergeMode({
    ...manualPolicy,
    allowedMergeModes: [...manualPolicy.allowedMergeModes],
  }, 'auto'), 'manual')
  assert.equal(manualMergeActionUrl({
    pullRequestUrl: 'https://github.com/acme/app/pull/12',
    repositoryWebUrl: 'https://github.com/acme/app',
    baseBranch: 'main',
    workingBranch: 'req/change',
  }), 'https://github.com/acme/app/pull/12')
})
