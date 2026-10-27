import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { evidenceProofPayload, verifyEvidenceNodeProof } from './evidence-proof';
import type { EvidenceNodeDemand } from '@task-weaver/contracts';

const id = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-10-27T10:00:00Z');
const demand: EvidenceNodeDemand = { requestId: id, outputId: id, projectId: id, requirementId: id, daemonId: id, nodeId: 'node', nonce: 'a'.repeat(64), purpose: 'preview', sizeBytes: 10, sha256: 'b'.repeat(64), expiresAt: new Date(now + 20_000).toISOString() };
test('proof binds the registered node key, request, output, manifest and deadline', () => {
  const pair = generateKeyPairSync('ed25519');
  const key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signature = sign(null, evidenceProofPayload(demand), pair.privateKey).toString('base64');
  assert.equal(verifyEvidenceNodeProof(demand, key, signature, now), true);
  assert.equal(verifyEvidenceNodeProof({ ...demand, outputId: '00000000-0000-4000-8000-000000000002' }, key, signature, now), false);
  assert.equal(verifyEvidenceNodeProof({ ...demand, sha256: 'c'.repeat(64) }, key, signature, now), false);
  assert.equal(verifyEvidenceNodeProof(demand, key, signature, now + 20_000), false);
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(verifyEvidenceNodeProof(demand, other, signature, now), false);
});
