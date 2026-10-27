import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceDemandPayload, type EvidenceNodeDemand } from '@task-weaver/contracts';
import { produceEvidence } from './evidence-producer';
import { signEvidenceRegistration } from './evidence-node-key';

test('producer proves its node and sends only a fully verified artifact in sequence', { skip: process.platform !== 'linux' }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'tw-producer-'));
  const previous = process.env.TW_CONFIG_DIR; process.env.TW_CONFIG_DIR = join(base, 'config');
  t.after(async () => { if (previous === undefined) delete process.env.TW_CONFIG_DIR; else process.env.TW_CONFIG_DIR = previous; await rm(base, { recursive: true, force: true }); });
  const root = join(base, 'artifacts'); await mkdir(join(root, 'lane'), { recursive: true });
  const content = Buffer.from('verified bytes'); await writeFile(join(root, 'lane', 'data'), content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = '00000000-0000-4000-8000-000000000001';
  const registration = signEvidenceRegistration({ requirementId: id, nodeId: 'node', relativePath: 'lane/data', sizeBytes: content.length, sha256 });
  const publicKey = createPublicKey({ key: Buffer.from(registration.nodePublicKey, 'base64'), format: 'der', type: 'spki' });
  const demand: EvidenceNodeDemand = { requestId: id, outputId: id, projectId: id, requirementId: id, daemonId: id, nodeId: 'node', nonce: 'a'.repeat(64), purpose: 'download', sizeBytes: content.length, sha256, expiresAt: new Date(Date.now() + 20_000).toISOString() };
  const chunks: Buffer[] = []; let finished = false;
  await produceEvidence(demand, { nodeId: 'node', root,
    claim: async (received, proof) => { assert.equal(verify(null, Buffer.from(evidenceDemandPayload(received)), publicKey, Buffer.from(proof, 'base64')), true); return { demand: received, relativePath: 'lane/data' }; },
    push: async (_received, sequence, bytes) => { assert.equal(sequence, chunks.length); chunks.push(Buffer.from(bytes)); },
    finish: async (_received, sequence) => { assert.equal(sequence, chunks.length); finished = true; },
  });
  assert.equal(finished, true); assert.deepEqual(Buffer.concat(chunks), content);
  await writeFile(join(root, 'lane', 'data'), 'changed bytes!');
  let sent = false;
  await assert.rejects(produceEvidence(demand, { nodeId: 'node', root, claim: async received => ({ demand: received, relativePath: 'lane/data' }), push: async () => { sent = true; }, finish: async () => {} }));
  assert.equal(sent, false);
});
