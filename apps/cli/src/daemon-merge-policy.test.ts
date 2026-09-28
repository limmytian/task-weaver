import assert from 'node:assert/strict'
import test from 'node:test'
import { manualMergeActionUrl, selectMergeMode } from './daemon-merge-policy.js'

const policy = {
  allowedMergeModes: ['provider', 'manual'] as const,
  defaultMergeMode: 'provider' as const,
  baseBranch: 'main',
}

test('selectMergeMode resolves auto from policy and accepts allowed overrides', () => {
  assert.equal(selectMergeMode({ ...policy, allowedMergeModes: [...policy.allowedMergeModes] }, 'auto'), 'provider')
  assert.equal(selectMergeMode({ ...policy, allowedMergeModes: [...policy.allowedMergeModes] }, 'manual'), 'manual')
})

test('selectMergeMode rejects policy-disallowed modes', () => {
  assert.throws(
    () => selectMergeMode({ ...policy, allowedMergeModes: [...policy.allowedMergeModes] }, 'direct'),
    /not allowed/,
  )
})

test('manualMergeActionUrl prefers a pull request and builds provider compare URLs', () => {
  assert.equal(manualMergeActionUrl({
    pullRequestUrl: 'https://github.com/acme/app/pull/12',
    repositoryWebUrl: 'https://github.com/acme/app',
    baseBranch: 'main',
    workingBranch: 'feature/review',
  }), 'https://github.com/acme/app/pull/12')
  assert.equal(manualMergeActionUrl({
    repositoryWebUrl: 'https://github.com/acme/app/',
    baseBranch: 'main',
    workingBranch: 'feature/review',
  }), 'https://github.com/acme/app/compare/main...feature%2Freview?expand=1')
  assert.equal(manualMergeActionUrl({
    repositoryWebUrl: 'https://gitea.example/acme/app',
    baseBranch: 'release',
    workingBranch: 'feature/review',
  }), 'https://gitea.example/acme/app/compare/release...feature%2Freview')
})
