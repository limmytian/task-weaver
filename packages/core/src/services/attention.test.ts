import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionCategory } from './attention';
import { attentionQuerySchema } from '@task-weaver/contracts';

test('deduplication prioritizes recovery, failure, review and dependency conditions', () => {
  assert.equal(attentionCategory({ recovery: true, failure: true, review: true, blocked: true }), 'recovery');
  assert.equal(attentionCategory({ recovery: false, failure: true, review: true, blocked: true }), 'failure');
  assert.equal(attentionCategory({ recovery: false, failure: false, review: true, blocked: true }), 'review');
  assert.equal(attentionCategory({ recovery: false, failure: false, review: false, blocked: true }), 'blocked');
  assert.equal(attentionCategory({ recovery: false, failure: false, review: false, blocked: false }), null);
});
test('retrieval rejects unbounded and malformed cursor input', () => {
  for (const input of [{ limit: 0 }, { limit: 51 }, { after: 'not-an-id' }, { category: 'all' }])
    assert.equal(attentionQuerySchema.safeParse(input).success, false);
  assert.equal(attentionQuerySchema.parse({}).limit, 25);
});
