import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenericGitAdapter,
  GiteaGitAdapter,
  GitHubGitAdapter,
  getGitProviderAdapter,
  type GitCommandResult,
  type GitRunner,
} from './git-provider.js'
import type { CredentialResolution } from './repository-credentials.js'

const credential: CredentialResolution = {
  state: 'available',
  reasonCode: 'test_ready',
  transport: 'https',
  operation: 'push',
  policyRevision: 1,
  checkedAt: '2026-07-19T00:00:00.000Z',
  trustedEnvironment: { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' },
  trustedGitConfig: ['-c', 'credential.helper='],
}

function response(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return { ok: true, status: 0, stdout: '', stderr: '', ...overrides }
}

function runner(entries: Array<[string, Partial<GitCommandResult>]>) {
  const calls: string[] = []
  const run: GitRunner = (command, args) => {
    const call = [command, ...args].join(' ')
    calls.push(call)
    const index = entries.findIndex(([needle]) => call.includes(needle))
    assert.notEqual(index, -1, `Unexpected command: ${call}`)
    const entry = entries.splice(index, 1)[0]!
    return response(entry[1])
  }
  return { calls, run }
}

const finalizeInput = {
  worktreePath: '/tmp/repository',
  branchName: 'req/change',
  baseBranch: 'main',
  title: 'Implement repository delivery',
  body: 'Automated delivery.',
  credential,
}

const githubPullRequest = JSON.stringify({
  number: 7,
  url: 'https://github.example/team/repository/pull/7',
  state: 'OPEN',
  headRefOid: 'def456',
  baseRefOid: 'abc123',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://checks.example/unit' },
  ],
  reviews: [
    { author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: '2026-07-24T00:00:00Z' },
  ],
})

test('generic adapter records an unchanged repository without pushing', async () => {
  const fake = runner([
    ['status --porcelain', {}],
    ['rev-parse HEAD', { stdout: 'abc123' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
  ])
  const result = await new GenericGitAdapter(fake.run).finalize(finalizeInput)
  assert.equal(result.deliveryStatus, 'unchanged')
  assert.equal(result.pushStatus, 'not_needed')
  assert.equal(fake.calls.some((call) => call.includes(' push ')), false)
})

test('generic adapter preserves a normalized push failure', async () => {
  const fake = runner([
    ['status --porcelain', {}],
    ['rev-parse HEAD', { stdout: 'def456' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
    ['push -u origin req/change', { ok: false, status: 1, stderr: 'denied' }],
  ])
  const result = await new GenericGitAdapter(fake.run).finalize(finalizeInput)
  assert.equal(result.deliveryStatus, 'failed')
  assert.equal(result.failureCode, 'git_push_failed')
  assert.match(result.failureSummary ?? '', /denied/)
})

test('generic adapter resumes after a completed push without repeating the network operation', async () => {
  const fake = runner([
    ['status --porcelain', {}],
    ['rev-parse HEAD', { stdout: 'def456' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
  ])
  const result = await new GenericGitAdapter(fake.run).finalize({
    ...finalizeInput,
    skipPush: true,
  })
  assert.equal(result.deliveryStatus, 'pushed')
  assert.equal(result.pushedCommit, 'def456')
  assert.equal(fake.calls.some((call) => call.includes(' push ')), false)
})

test('GitHub adapter creates a pull request after a successful push', async () => {
  const fake = runner([
    ['status --porcelain', {}],
    ['rev-parse HEAD', { stdout: 'def456' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
    ['push -u origin req/change', {}],
    ['gh pr view', { ok: false, status: 1, stderr: 'no pull requests found' }],
    ['gh pr create', { stdout: 'https://github.example/team/repository/pull/7' }],
    ['gh pr view', { stdout: githubPullRequest }],
  ])
  const result = await new GitHubGitAdapter(fake.run).finalize({
    ...finalizeInput,
    forgeCredential: { ...credential, operation: 'forge' },
  })
  assert.equal(result.deliveryStatus, 'in_review')
  assert.equal(result.reviewStatus, 'in_review')
  assert.equal(result.pullRequestUrl, 'https://github.example/team/repository/pull/7')
  assert.equal(result.pullRequestExternalId, '7')
  assert.equal(getGitProviderAdapter('github').capabilities.pullRequest, true)
  assert.equal(getGitProviderAdapter('gitea').capabilities.pullRequest, true)
})

test('GitHub adapter normalizes checks and approvals and posts structured review summaries', async () => {
  const fake = runner([
    ['gh pr view', { stdout: githubPullRequest }],
    ['gh pr review', {}],
    ['gh pr view', { stdout: githubPullRequest }],
  ])
  const adapter = new GitHubGitAdapter(fake.run)
  const options = {
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' as const },
  }
  const found = await adapter.findPullRequest(options)
  assert.equal(found.ok, true)
  if (!found.ok || !found.value) return
  assert.equal(found.value.checks[0]?.state, 'passed')
  assert.equal(found.value.approvals[0]?.state, 'approved')
  const reviewed = await adapter.postReviewSummary({
    ...options,
    pullRequest: found.value,
    summary: 'Structured review summary',
    decision: 'approve',
  })
  assert.equal(reviewed.ok, true)
  assert.ok(fake.calls.some((call) => call.includes('pr review 7 --approve')))
})

test('GitHub adapter fences provider merge by expected head and classifies branch protection as policy', async () => {
  const adapter = new GitHubGitAdapter(() => {
    throw new Error('stale head must not call the provider')
  })
  const stale = await adapter.mergePullRequest({
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' },
    pullRequest: {
      provider: 'github', externalId: '7', url: 'https://github.example/pr/7', state: 'open',
      headCommit: 'new-head', baseCommit: 'base', mergeable: true, mergeState: 'clean', checks: [], approvals: [],
    },
    expectedHeadCommit: 'approved-head',
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.failure.code, 'forge_stale_head')

  const fake = runner([
    ['gh pr merge', { ok: false, status: 1, stderr: 'protected branch requires approving review' }],
  ])
  const blocked = await new GitHubGitAdapter(fake.run).mergePullRequest({
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' },
    pullRequest: {
      provider: 'github', externalId: '7', url: 'https://github.example/pr/7', state: 'open',
      headCommit: 'approved-head', baseCommit: 'base', mergeable: false, mergeState: 'blocked', checks: [], approvals: [],
    },
    expectedHeadCommit: 'approved-head',
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.failure.category, 'policy')
    assert.equal(blocked.failure.retry, 'manual')
  }
})

test('GitHub adapter treats an already merged pull request as idempotent', async () => {
  const adapter = new GitHubGitAdapter(() => {
    throw new Error('an already merged pull request must not call the provider')
  })
  const pullRequest = {
    provider: 'github', externalId: '7', url: 'https://github.example/pr/7', state: 'merged' as const,
    headCommit: 'approved-head', baseCommit: 'base', mergeable: true, mergeState: 'clean', checks: [], approvals: [],
  }
  const merged = await adapter.mergePullRequest({
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' },
    pullRequest,
    expectedHeadCommit: 'approved-head',
  })
  assert.deepEqual(merged, { ok: true, value: pullRequest })
})

test('Gitea adapter creates, reviews, refreshes, and merges pull requests through tea', async () => {
  const giteaPull = JSON.stringify({
    index: 12,
    html_url: 'https://gitea.example/team/repository/pulls/12',
    state: 'open',
    head: { ref: 'req/change', sha: 'def456' },
    base: { ref: 'main', sha: 'abc123' },
    mergeable: true,
    statuses: [{ context: 'unit', status: 'success' }],
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED' }],
  })
  const fake = runner([
    ['tea pulls list', { stdout: '[]' }],
    ['tea pulls create', { stdout: giteaPull }],
    ['tea pulls review', {}],
    ['tea pulls view', { stdout: giteaPull }],
    ['tea pulls merge', {}],
    ['tea pulls view', { stdout: JSON.stringify({ ...JSON.parse(giteaPull), merged: true }) }],
  ])
  const adapter = new GiteaGitAdapter(fake.run)
  const options = {
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' as const },
    repository: { host: 'gitea.example', namespace: 'team', name: 'repository' },
  }
  const ensured = await adapter.ensurePullRequest(options)
  assert.equal(ensured.ok, true)
  if (!ensured.ok) return
  assert.equal(ensured.value.externalId, '12')
  assert.equal(ensured.value.checks[0]?.state, 'passed')
  const reviewed = await adapter.postReviewSummary({
    ...options,
    pullRequest: ensured.value,
    summary: 'Looks good',
    decision: 'approve',
  })
  assert.equal(reviewed.ok, true)
  const merged = await adapter.mergePullRequest({
    ...options,
    pullRequest: ensured.value,
    expectedHeadCommit: 'def456',
  })
  assert.equal(merged.ok, true)
  if (merged.ok) assert.equal(merged.value.state, 'merged')
})

test('generic Git fallback reports forge policy as unsupported without fabricating evidence', async () => {
  const adapter = new GenericGitAdapter()
  const result = await adapter.findPullRequest({
    ...finalizeInput,
    credential: { ...credential, operation: 'forge' },
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.failure.category, 'not_supported')
    assert.equal(result.failure.retry, 'manual')
  }
})

test('GitHub adapter refuses forge operations without forge-scoped readiness', async () => {
  const fake = runner([
    ['status --porcelain', {}],
    ['rev-parse HEAD', { stdout: 'def456' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
    ['push -u origin req/change', {}],
  ])
  const result = await new GitHubGitAdapter(fake.run).finalize(finalizeInput)
  assert.equal(result.pushStatus, 'pushed')
  assert.equal(result.deliveryStatus, 'failed')
  assert.equal(result.failureCode, 'forge_credential_unavailable')
  assert.equal(fake.calls.some((call) => call.startsWith('gh ')), false)
})
