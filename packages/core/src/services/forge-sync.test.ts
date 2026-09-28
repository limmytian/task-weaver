import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateForgeSyncGuard, mapForgeSnapshot, requirementStatusFromForgeDeliveries } from './forge-sync'

const snapshot = {
  provider: 'github', externalId: '12', url: 'https://github.com/acme/app/pull/12',
  state: 'open' as const, headCommit: 'aaaaaaaa', baseCommit: 'bbbbbbbb',
  mergeable: true, mergeState: 'clean', checks: [], approvals: [],
}

test('forge synchronization invalidates approval when the provider head changes', () => {
  assert.deepEqual(mapForgeSnapshot({
    currentDeliveryStatus: 'ready_to_merge',
    currentHeadCommit: 'cccccccc',
    snapshot,
    currentHeadApproved: true,
  }), {
    deliveryStatus: 'in_review', reviewStatus: 'in_review', mergeStatus: 'pending',
    failureCode: null, failureSummary: null, invalidateReview: true, staleHead: true,
  })
})

test('forge synchronization maps merged, closed, reopened, and terminal snapshots', () => {
  assert.equal(mapForgeSnapshot({
    currentDeliveryStatus: 'ready_to_merge', currentHeadCommit: snapshot.headCommit,
    snapshot: { ...snapshot, state: 'merged' }, currentHeadApproved: true,
  }).deliveryStatus, 'merged')
  assert.equal(mapForgeSnapshot({
    currentDeliveryStatus: 'ready_to_merge', currentHeadCommit: snapshot.headCommit,
    snapshot: { ...snapshot, state: 'closed' }, currentHeadApproved: true,
  }).failureCode, 'forge_pull_request_closed')
  assert.equal(mapForgeSnapshot({
    currentDeliveryStatus: 'failed', currentHeadCommit: snapshot.headCommit,
    snapshot, currentHeadApproved: true,
  }).deliveryStatus, 'ready_to_merge')
  assert.equal(mapForgeSnapshot({
    currentDeliveryStatus: 'merged', currentHeadCommit: snapshot.headCommit,
    snapshot: { ...snapshot, state: 'open' }, currentHeadApproved: false,
  }).deliveryStatus, 'merged')
})

test('requirement status reflects the earliest incomplete repository phase', () => {
  assert.equal(requirementStatusFromForgeDeliveries(['merged', 'unchanged']), 'done')
  assert.equal(requirementStatusFromForgeDeliveries(['ready_to_merge', 'in_review']), 'in_review')
  assert.equal(requirementStatusFromForgeDeliveries(['ready_to_merge', 'pending']), 'in_progress')
  assert.equal(requirementStatusFromForgeDeliveries(['ready_to_merge', 'merged']), 'ready_to_merge')
})

test('forge synchronization retries are idempotent and stale writers are rejected', () => {
  const base = {
    previousIdempotencyKey: 'github:12:snapshot-a',
    currentRevision: 4,
    previousObservedAt: new Date('2026-07-24T08:00:00.000Z'),
    observedAt: new Date('2026-07-24T08:01:00.000Z'),
    idempotencyKey: 'github:12:snapshot-a',
  }
  assert.equal(evaluateForgeSyncGuard({ ...base, expectedRevision: 3 }).action, 'idempotent')
  assert.equal(evaluateForgeSyncGuard({
    ...base, idempotencyKey: 'github:12:snapshot-b', expectedRevision: 3,
  }).action, 'revision_conflict')
  assert.equal(evaluateForgeSyncGuard({
    ...base,
    idempotencyKey: 'github:12:snapshot-b',
    expectedRevision: 4,
    observedAt: new Date('2026-07-24T07:59:00.000Z'),
  }).action, 'stale_observation')
})
