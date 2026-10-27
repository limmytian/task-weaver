import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EvidenceHandshake } from './evidence-handshake';
import { evidenceProofPayload } from './evidence-proof';

const id = '00000000-0000-4000-8000-000000000001';
const reader = { actorId: 'reader', credentialId: 'reader-key' };
const producer = { actorId: 'agent', credentialId: 'agent-key', daemonId: id, nodeId: 'node' };
const keyPair = generateKeyPairSync('ed25519');
const output = { outputId: id, projectId: id, requirementId: id, daemonId: id, nodeId: 'node', producerActorId: 'agent', relativePath: 'private/artifact', sizeBytes: 10, sha256: 'a'.repeat(64), nodePublicKey: keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
test('only the selected producer with the bound key receives a path', async () => {
  const broker = new EvidenceHandshake(async () => {});
  const request = await broker.open(reader, output, 'preview');
  assert.deepEqual(await broker.poll({ ...producer, actorId: 'other' }), []);
  const [demand] = await broker.poll(producer); assert.ok(demand);
  assert.equal('relativePath' in demand, false);
  const wrong = generateKeyPairSync('ed25519');
  await assert.rejects(broker.prove(producer, request.requestId, sign(null, evidenceProofPayload(demand), wrong.privateKey).toString('base64')));
  const signature = sign(null, evidenceProofPayload(demand), keyPair.privateKey).toString('base64');
  assert.equal((await broker.prove(producer, request.requestId, signature)).relativePath, output.relativePath);
  await assert.rejects(broker.prove(producer, request.requestId, signature));
  await broker.recheck(producer, request.requestId);
  await broker.cancel(reader, request.requestId);
  await assert.rejects(broker.recheck(producer, request.requestId));
  broker.close();
});
test('revocation removes a pending demand before the producer can use it', async () => {
  let allowed = true;
  const broker = new EvidenceHandshake(async side => { if (side === 'reader' && !allowed) throw new Error('revoked'); });
  await broker.open(reader, output, 'download'); allowed = false;
  assert.deepEqual(await broker.poll(producer), []);
  broker.close();
});
