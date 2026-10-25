import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { projectExecutionRecoveryView } from './execution-recovery-view';

const now = new Date('2026-01-01T00:00:00Z');
const requirement = { status: 'in_progress' as const, planRevision: 7, evidenceNeedsReview: true, recoveryAttempts: 2, recoveryPolicy: { retrySafe: false, maxAttempts: 3, graceMs: 120000 } };
const control = { id: randomUUID(), requirementId: randomUUID(), projectId: randomUUID(), daemonId: randomUUID(), runId: randomUUID(), revision: 7, reason: 'Plan changed', phase: 'received' as const, workspace: { nodeId: 'node-a', state: 'dirty', path: '/private/local/path', summary: 'unneeded raw content', secret: 'never expose' }, deadline: new Date(now.getTime() + 1000), createdAt: new Date(now.getTime() - 1000), updatedAt: now };
const permissions = { human: true, write: true, manage: true };

test('recovery projection separates lease occupancy, stop reports and unknown capacity', () => {
  const view = projectExecutionRecoveryView(requirement, [control], { id: control.runId, expiresAt: new Date(now.getTime() + 1000) }, permissions, now);
  assert.equal(view.lane.state, 'held');
  assert.equal(view.lane.executionAuthority, 'not_established');
  assert.equal(view.lane.daemonHealth, 'not_observed');
  assert.equal(view.lane.fleetCapacity, null);
  assert.equal(view.controls[0]!.stopObservation, 'not_established');
  assert.deepEqual(view.controls[0]!.observations.map(observation => observation.kind), ['created', 'latest_phase']);
  assert.equal(view.retry.remaining, 1);
  assert.doesNotMatch(JSON.stringify(view), /private\/local|unneeded raw|secret|never expose/);
  const blocked = projectExecutionRecoveryView(requirement, [{ ...control, phase: 'blocked' }], undefined, permissions, now);
  assert.equal(blocked.lane.state, 'not_held');
  assert.equal(blocked.lane.fleetCapacity, null, 'released lane does not establish free fleet slots');
  const resumed = projectExecutionRecoveryView(requirement, [{ ...control, phase: 'resumed' }], undefined, permissions, now);
  assert.equal(resumed.controls[0]!.stopObservation, 'not_established', 'recovery decision does not establish termination');
  assert.equal(resumed.actions.recover.blockedReason, 'already_decided');
});

test('fresh permission/revision projection blocks agent, narrowed and replacement actions', () => {
  assert.equal(projectExecutionRecoveryView(requirement, [control], undefined, { human: false, write: true, manage: true }, now).actions.recover.blockedReason, 'human_required');
  const viewer = projectExecutionRecoveryView(requirement, [control], undefined, { human: true, write: false, manage: false }, now);
  assert.equal(viewer.actions.revalidate.blockedReason, 'write_permission_required');
  assert.equal(viewer.actions.recover.blockedReason, 'management_permission_required');
  assert.equal(projectExecutionRecoveryView(requirement, [control], { id: randomUUID(), expiresAt: now }, permissions, now).actions.recover.blockedReason, 'replacement_owns_lane');
  assert.equal(projectExecutionRecoveryView({ ...requirement, status: 'done' }, [control], undefined, permissions, now).actions.recover.blockedReason, 'requirement_closed');
  assert.equal(projectExecutionRecoveryView({ ...requirement, evidenceNeedsReview: false }, [], undefined, permissions, now).actions.revalidate.blockedReason, 'evidence_current');
  const stopped = projectExecutionRecoveryView(requirement, [{ ...control, phase: 'stopped', deadline: now }], undefined, permissions, now);
  assert.equal(stopped.controls[0]!.stopObservation, 'reported_in_current_phase');
  assert.equal(stopped.controls[0]!.deadlinePassed, true);
  assert.equal(stopped.actions.recover.expectedControlUpdatedAt, now.toISOString());
});
