import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewPolicyInputSchema } from '../schemas/reviews'
import { mapForgeSnapshot } from './forge-sync'
import { evaluateReviewPolicy } from './reviews'

const headCommit = 'abcdef123456'
const executor = { actorId: 'executor', actorType: 'agent' as const, daemonId: 'daemon-executor' }
const reviewer = { actorId: 'reviewer', actorType: 'agent' as const, daemonId: 'daemon-reviewer' }

function policy(overrides: Record<string, unknown> = {}) {
  return reviewPolicyInputSchema.parse({
    allowedMergeModes: ['provider', 'direct', 'manual'],
    defaultMergeMode: 'provider',
    ...overrides,
  })
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    headCommit,
    checks: [] as Array<{ name: string; status: string }>,
    findings: [] as Array<{ severity: string; status: string }>,
    decisions: [] as Array<{
      kind: string
      decision: string
      headCommit: string
      actorId: string
      actorType: string
      daemonId: string | null
      reason: string | null
      metadata?: Record<string, unknown>
    }>,
    executor,
    reviewer,
    mergeMode: 'provider' as const,
    ...overrides,
  }
}

test('AI-only, check-only, human-required, and independent-review policies stay distinct', () => {
  const aiOnly = evaluateReviewPolicy(policy({ requireAiReview: true }), input({
    decisions: [{
      kind: 'ai', decision: 'approved', headCommit, actorId: 'reviewer', actorType: 'agent',
      daemonId: 'daemon-reviewer', reason: null,
    }],
  }))
  assert.equal(aiOnly.satisfied, true)
  assert.ok(aiOnly.evidence.includes('ai_review'))

  const checkOnly = evaluateReviewPolicy(policy({ requiredChecks: ['ci'] }), input({
    checks: [{ name: 'ci', status: 'passed' }],
  }))
  assert.equal(checkOnly.satisfied, true)

  const humanRequired = evaluateReviewPolicy(policy({ minimumHumanApprovals: 1 }), input({
    decisions: [{
      kind: 'human', decision: 'approved', headCommit, actorId: 'alice', actorType: 'human',
      daemonId: null, reason: null,
    }],
  }))
  assert.equal(humanRequired.satisfied, true)

  const identityReuse = evaluateReviewPolicy(policy({ requireIndependentReviewer: true }), input({
    reviewer: executor,
  }))
  assert.equal(identityReuse.satisfied, false)
  assert.ok(identityReuse.blockers.some((blocker) => blocker.includes('independent')))
})

test('GitHub/Gitea-shaped forge approvals combine with AI and checks for current head only', () => {
  for (const provider of ['github', 'gitea']) {
    const evaluation = evaluateReviewPolicy(policy({
      requiredChecks: ['ci'],
      requireAiReview: true,
      minimumHumanApprovals: 1,
      requireIndependentReviewer: true,
    }), input({
      checks: [{ name: 'ci', status: 'passed' }],
      decisions: [{
        kind: 'ai', decision: 'approved', headCommit, actorId: 'reviewer', actorType: 'agent',
        daemonId: 'daemon-reviewer', reason: null,
      }, {
        kind: 'forge', decision: 'approved', headCommit, actorId: 'reviewer', actorType: 'agent',
        daemonId: 'daemon-reviewer', reason: null,
        metadata: { provider, approvals: [
          { actorId: 'alice', state: 'approved', headCommit },
          { actorId: 'stale', state: 'approved', headCommit: 'oldhead12345' },
        ] },
      }],
    }))
    assert.equal(evaluation.satisfied, true, evaluation.blockers.join('; '))
    assert.ok(evaluation.evidence.includes('forge_approval'))
    assert.ok(evaluation.evidence.includes('human_approvals:1'))
  }
})

test('stale commits invalidate approval and a reasoned human override remains explicit', () => {
  const stale = evaluateReviewPolicy(policy({ requireAiReview: true }), input({
    decisions: [{
      kind: 'ai', decision: 'approved', headCommit: 'oldhead12345', actorId: 'reviewer', actorType: 'agent',
      daemonId: 'daemon-reviewer', reason: null,
    }],
  }))
  assert.equal(stale.satisfied, false)

  const synchronized = mapForgeSnapshot({
    currentDeliveryStatus: 'ready_to_merge',
    currentHeadCommit: headCommit,
    snapshot: {
      provider: 'github', externalId: '12', url: 'https://github.com/acme/app/pull/12',
      state: 'open', headCommit: 'newhead12345', baseCommit: 'base12345678',
      mergeable: true, mergeState: 'clean', checks: [], approvals: [],
    },
    currentHeadApproved: true,
  })
  assert.equal(synchronized.deliveryStatus, 'in_review')
  assert.equal(synchronized.invalidateReview, true)

  const override = evaluateReviewPolicy(policy({
    requiredChecks: ['ci'], allowManualOverride: true, overrideRequiresReason: true,
  }), input({
    decisions: [{
      kind: 'override', decision: 'bypassed', headCommit, actorId: 'operator', actorType: 'human',
      daemonId: null, reason: 'Incident INC-42',
    }],
  }))
  assert.deepEqual(override, {
    satisfied: true, evidence: ['manual_override'], blockers: [], overridden: true,
  })
})
