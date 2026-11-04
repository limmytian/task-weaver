import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatReviewDecision } from './review-references';

test('associates each reference with its own feedback in the decision', () => {
  assert.equal(formatReviewDecision(' Changes needed ', [{ target: 'a.ts:4', comment: ' Fix validation ' }, { target: 'b.ts:9', comment: 'Explain this' }]), 'Changes needed\n\nReferenced feedback:\n1. a.ts:4\n   Fix validation\n\n2. b.ts:9\n   Explain this');
  assert.equal(formatReviewDecision(' Approved ', []), 'Approved');
  assert.equal(formatReviewDecision('', [{ target: 'a.ts:4', comment: 'Fix validation' }]), 'Referenced feedback:\n1. a.ts:4\n   Fix validation');
});
