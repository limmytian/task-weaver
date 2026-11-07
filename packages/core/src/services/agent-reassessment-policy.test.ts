import assert from 'node:assert/strict';
import test from 'node:test';
import { reassessmentDisposition, type Reassessment, type ReassessmentGrant } from './agent-reassessment-policy';

const now = new Date('2026-01-01T00:00:00Z');
const grant: ReassessmentGrant = { projectId: 'p', requirementId: 'r', agentId: 'a', operations: ['revalidate_evidence'], expiresAt: new Date('2026-01-02T00:00:00Z'), revokedAt: null };
const assessment: Reassessment = { projectId: 'p', requirementId: 'r', agentId: 'a', operation: 'revalidate_evidence', expectedRevision: 4, decision: 'accept', evidence: [{ reference: 'output:1', rationale: 'Checked against the change' }], rationale: 'Still satisfies the plan', inputsAvailable: true, uncertainExternalEffects: false };

test('acceptance requires a current scoped and live grant', () => {
  assert.equal(reassessmentDisposition(grant, assessment, 4, now), 'accept');
  assert.equal(reassessmentDisposition({ ...grant, requirementId: null }, assessment, 4, now), 'accept');
  for (const candidate of [null, { ...grant, projectId: 'other' }, { ...grant, requirementId: 'other' }, { ...grant, agentId: 'other' }, { ...grant, operations: [] }, { ...grant, revokedAt: now }, { ...grant, expiresAt: now }] as (ReassessmentGrant | null)[]) assert.equal(reassessmentDisposition(candidate, assessment, 4, now), 'unauthorized');
  assert.equal(reassessmentDisposition(grant, assessment, 5, now), 'stale');
});

test('missing evidence, uncertainty and explicit escalation require a human', () => {
  for (const change of [{ evidence: [] }, { evidence: [{ reference: '', rationale: 'x' }] }, { rationale: ' ' }, { inputsAvailable: false }, { uncertainExternalEffects: true }, { decision: 'escalate' as const }]) assert.equal(reassessmentDisposition(grant, { ...assessment, ...change }, 4, now), 'escalate');
});
