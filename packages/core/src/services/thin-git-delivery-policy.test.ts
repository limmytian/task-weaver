import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceGitDelivery, gitDeliveryBlocksBranch } from './thin-git-delivery-policy'

test('a lost push response retains the branch until the external outcome is resolved', () => {
  const pushing = advanceGitDelivery('prepared', 'start_push')
  const uncertain = advanceGitDelivery(pushing, 'response_lost')
  assert.equal(gitDeliveryBlocksBranch(uncertain), true)
  assert.throws(() => advanceGitDelivery(uncertain, 'start_push'))
  assert.throws(() => advanceGitDelivery(uncertain, 'definitely_not_started'))
  assert.equal(gitDeliveryBlocksBranch(advanceGitDelivery(uncertain, 'verified')), false)
  assert.equal(gitDeliveryBlocksBranch(advanceGitDelivery(uncertain, 'operator_verified_abandon')), false)
})
