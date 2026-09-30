import type {
  ForgePullRequestSnapshot,
  RepositoryDeliveryStatus,
  RepositoryMergeStatus,
  RepositoryReviewStatus,
} from "@task-weaver/contracts"

export interface ForgeSyncTransition {
  deliveryStatus: RepositoryDeliveryStatus
  reviewStatus: RepositoryReviewStatus
  mergeStatus: RepositoryMergeStatus
  failureCode: string | null
  failureSummary: string | null
  invalidateReview: boolean
  staleHead: boolean
}

export type ForgeSyncGuard =
  | { action: 'idempotent' }
  | { action: 'proceed' }
  | { action: 'revision_conflict' }
  | { action: 'stale_observation' }

export function evaluateForgeSyncGuard(input: {
  previousIdempotencyKey?: string | null
  currentRevision: number
  expectedRevision?: number
  previousObservedAt?: Date | null
  observedAt: Date
  idempotencyKey: string
}): ForgeSyncGuard {
  if (input.previousIdempotencyKey === input.idempotencyKey) return { action: 'idempotent' }
  if (input.expectedRevision !== undefined && input.expectedRevision !== input.currentRevision) {
    return { action: 'revision_conflict' }
  }
  if (input.previousObservedAt && input.observedAt < input.previousObservedAt) {
    return { action: 'stale_observation' }
  }
  return { action: 'proceed' }
}

export function mapForgeSnapshot(input: {
  currentDeliveryStatus: RepositoryDeliveryStatus
  currentHeadCommit: string | null
  snapshot: ForgePullRequestSnapshot
  currentHeadApproved: boolean
}): ForgeSyncTransition {
  const { currentDeliveryStatus, currentHeadCommit, snapshot, currentHeadApproved } = input
  if (currentDeliveryStatus === 'merged') {
    return {
      deliveryStatus: 'merged', reviewStatus: 'approved', mergeStatus: 'merged',
      failureCode: null, failureSummary: null, invalidateReview: false, staleHead: false,
    }
  }
  if (snapshot.state === 'merged') {
    return {
      deliveryStatus: 'merged', reviewStatus: 'approved', mergeStatus: 'merged',
      failureCode: null, failureSummary: null, invalidateReview: false, staleHead: false,
    }
  }
  const staleHead = Boolean(
    snapshot.headCommit
    && currentHeadCommit
    && snapshot.headCommit !== currentHeadCommit,
  )
  if (staleHead) {
    return {
      deliveryStatus: 'in_review', reviewStatus: 'in_review', mergeStatus: 'pending',
      failureCode: null,
      failureSummary: null,
      invalidateReview: true,
      staleHead: true,
    }
  }
  if (snapshot.state === 'closed') {
    return {
      deliveryStatus: 'failed', reviewStatus: 'changes_requested', mergeStatus: 'failed',
      failureCode: 'forge_pull_request_closed',
      failureSummary: 'The provider pull request was closed without merging',
      invalidateReview: false,
      staleHead: false,
    }
  }
  if (currentHeadApproved) {
    return {
      deliveryStatus: 'ready_to_merge', reviewStatus: 'approved', mergeStatus: 'ready',
      failureCode: null, failureSummary: null, invalidateReview: false, staleHead: false,
    }
  }
  return {
    deliveryStatus: 'in_review', reviewStatus: 'in_review', mergeStatus: 'pending',
    failureCode: null, failureSummary: null, invalidateReview: false, staleHead: false,
  }
}

export function requirementStatusFromForgeDeliveries(
  statuses: RepositoryDeliveryStatus[],
): 'in_progress' | 'in_review' | 'ready_to_merge' | 'done' {
  if (statuses.every((status) => status === 'merged' || status === 'unchanged')) return 'done'
  if (statuses.some((status) => ['pending', 'provisioning', 'ready', 'changed', 'pushing'].includes(status))) {
    return 'in_progress'
  }
  if (statuses.some((status) => ['pushed', 'in_review', 'failed'].includes(status))) return 'in_review'
  return 'ready_to_merge'
}
