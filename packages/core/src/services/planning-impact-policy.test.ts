import assert from 'node:assert/strict';
import test from 'node:test';
import { isExecutionPlanChange, recoveryDisposition } from './planning-impact-policy';

test('planning inputs invalidate while unchanged fields and runtime metadata do not', () => {
  for (const operation of ['updateTask', 'updateRequirement', 'updateExecutionSlice']) {
    assert.ok(isExecutionPlanChange(operation, { description: 'new acceptance' }, { description: 'old' }));
    assert.equal(isExecutionPlanChange(operation, { description: 'same' }, { description: 'same' }), false);
    assert.equal(isExecutionPlanChange(operation, { priority: 'high', modelTier: 'strong', resultSummary: 'progress' }), false);
  }
  for (const operation of ['addTaskDependency', 'removeTaskDependency', 'addRequirementDependency', 'createExecutionSlice', 'removeRequirementRepository', 'addWorkflowInput']) assert.ok(isExecutionPlanChange(operation));
  assert.ok(isExecutionPlanChange('updateRequirement', { status: 'draft' }, { status: 'in_progress' }));
  assert.equal(isExecutionPlanChange('updateTaskStatus', { status: 'done' }), false);
  assert.equal(isExecutionPlanChange('addTaskComment'), false);
});

test('recovery requires fenced authority, bounded grace, explicit retry safety and finite attempts', () => {
  const base = { now: 10000, lastObservedAt: 1000, authorityExpiresAt: 20000, revoked: false, attempts: 0,
    policy: { retrySafe: false, maxAttempts: 2, graceMs: 10000 }, sameNode: false, stopped: false, inputsAvailable: true, uncertainEffects: false };
  assert.equal(recoveryDisposition(base), 'awaiting_authority');
  assert.equal(recoveryDisposition({ ...base, revoked: true }), 'awaiting_node');
  assert.equal(recoveryDisposition({ ...base, revoked: true, now: 11000 }), 'manual_retry_safety');
  assert.equal(recoveryDisposition({ ...base, revoked: true, sameNode: true, stopped: true }), 'local_reassessment');
  assert.equal(recoveryDisposition({ ...base, revoked: true, sameNode: true, stopped: false }), 'awaiting_node');
  const retry = { ...base, now: 30000, policy: { ...base.policy, retrySafe: true } };
  assert.equal(recoveryDisposition(retry), 'restart_with_possible_local_loss');
  assert.equal(recoveryDisposition({ ...retry, attempts: 2 }), 'retry_exhausted');
  assert.equal(recoveryDisposition({ ...retry, inputsAvailable: false }), 'input_unavailable');
  assert.equal(recoveryDisposition({ ...retry, uncertainEffects: true }), 'manual_external_outcome');
});
