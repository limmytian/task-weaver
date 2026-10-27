import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityAcceptanceFixture, verifyCapabilityAcceptanceArtifact } from './capability-acceptance-fixture.mjs';

test('a persisted fixture has identical independent baseline and candidate expectations', () => {
  const fixture = createCapabilityAcceptanceFixture();
  const restored = JSON.parse(JSON.stringify(fixture));
  assert.deepEqual(verifyCapabilityAcceptanceArtifact(restored, fixture.expected), { artifactCorrect: true, adoptionVerified: false, modelCost: null });
  assert.doesNotMatch(fixture.skill.content, new RegExp(fixture.expected.customer));
  assert.doesNotMatch(fixture.memory.content, /unitCents|feeCents/);
  assert.throws(() => verifyCapabilityAcceptanceArtifact(fixture, { ...fixture.expected, totalCents: fixture.expected.totalCents + fixture.tool.result.feeCents }));
  assert.throws(() => verifyCapabilityAcceptanceArtifact(fixture, { ...fixture.expected, currency: 'EUR' }));
  assert.throws(() => verifyCapabilityAcceptanceArtifact(fixture, { ...fixture.expected, sourceRevision: 0 }));
  assert.throws(() => verifyCapabilityAcceptanceArtifact(fixture, { ...fixture.expected, adopted: true }));
});

test('irrelevant work can pass without pretending capability adoption or measured cost', () => {
  const fixture = createCapabilityAcceptanceFixture();
  assert.equal(verifyCapabilityAcceptanceArtifact(fixture, { sum: 5 }, 'irrelevant').adoptionVerified, false);
  assert.throws(() => verifyCapabilityAcceptanceArtifact(fixture, { sum: 5 }, 'unknown'));
});
