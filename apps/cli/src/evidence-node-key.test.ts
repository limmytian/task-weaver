import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceRegistrationPayload } from '@task-weaver/contracts';
import { signEvidenceRegistration } from './evidence-node-key';

test('local node key is persistent, private and signs the exact registered manifest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tw-node-key-'));
  const previous = process.env.TW_CONFIG_DIR; process.env.TW_CONFIG_DIR = directory;
  t.after(async () => { if (previous === undefined) delete process.env.TW_CONFIG_DIR; else process.env.TW_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  const input = { requirementId: 'requirement', nodeId: 'node', relativePath: 'lane/artifact', sizeBytes: 3, sha256: 'a'.repeat(64) };
  const first = signEvidenceRegistration(input), second = signEvidenceRegistration(input);
  assert.equal(first.nodePublicKey, second.nodePublicKey);
  assert.equal((await lstat(join(directory, 'evidence-node-key.pem'))).mode & 0o077, 0);
  const key = createPublicKey({ key: Buffer.from(first.nodePublicKey, 'base64'), format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.from(evidenceRegistrationPayload(input)), key, Buffer.from(first.nodeRegistrationProof, 'base64')), true);
  assert.equal(verify(null, Buffer.from(evidenceRegistrationPayload({ ...input, sizeBytes: 4 })), key, Buffer.from(first.nodeRegistrationProof, 'base64')), false);
});
