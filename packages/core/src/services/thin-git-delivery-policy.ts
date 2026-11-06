/** An external push may complete after the caller loses its connection or lease. */
export type GitDeliveryState = 'prepared' | 'pushing' | 'confirmed' | 'uncertain' | 'abandoned'
export type GitDeliveryEvent = 'start_push' | 'verified' | 'response_lost' | 'definitely_not_started' | 'operator_verified_abandon'

/** Uncertain pushes retain the branch slot until an operator resolves the external outcome. */
export function advanceGitDelivery(state: GitDeliveryState, event: GitDeliveryEvent): GitDeliveryState {
  if (state === 'prepared' && event === 'start_push') return 'pushing'
  if (state === 'prepared' && event === 'definitely_not_started') return 'abandoned'
  if (state === 'pushing' && event === 'verified') return 'confirmed'
  if (state === 'pushing' && event === 'response_lost') return 'uncertain'
  if (state === 'uncertain' && event === 'verified') return 'confirmed'
  if (state === 'uncertain' && event === 'operator_verified_abandon') return 'abandoned'
  throw new Error(`Invalid Git delivery transition: ${state} → ${event}`)
}

export function gitDeliveryBlocksBranch(state: GitDeliveryState) {
  return state === 'prepared' || state === 'pushing' || state === 'uncertain'
}
