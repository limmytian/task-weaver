import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EvidenceTransferBuffer } from './evidence-transfer';

const reader = { actorId: 'reader', credentialId: 'reader-key' };
const producer = { actorId: 'agent', credentialId: 'agent-key', daemonId: 'daemon', nodeId: 'node' };
const content = Buffer.from('verified evidence');
const manifest = { transferId: 'transfer', outputId: 'output', projectId: 'project', requirementId: 'requirement', nodeId: 'node', purpose: 'preview' as const, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
const collect = async (input: AsyncGenerator<Buffer>) => { const chunks: Buffer[] = []; for await (const chunk of input) chunks.push(chunk); return Buffer.concat(chunks); };

test('only the bound producer can provide ordered bytes and readers see verified content', async () => {
  const manager = new EvidenceTransferBuffer(async () => {});
  const request = await manager.open(reader, producer, manifest);
  await assert.rejects(collect(manager.read(reader, request.requestId)), /not verified/);
  await assert.rejects(manager.push({ ...producer, daemonId: 'other' }, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content }));
  await manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content });
  await manager.finish(producer, { ...request, outputId: manifest.outputId, sequence: 1 });
  assert.deepEqual(await collect(manager.read(reader, request.requestId)), content);
  await assert.rejects(collect(manager.read(reader, request.requestId)));
});
test('replay, fingerprint mismatch, cancellation and revocation fail closed', async () => {
  let allowed = true;
  const manager = new EvidenceTransferBuffer(async side => { if (side === 'reader' && !allowed) throw new Error('revoked'); });
  let request = await manager.open(reader, producer, manifest);
  await manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content });
  await assert.rejects(manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content }), /replayed/);
  request = await manager.open(reader, producer, manifest);
  await manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: Buffer.alloc(content.length) });
  await assert.rejects(manager.finish(producer, { ...request, outputId: manifest.outputId, sequence: 1 }), /fingerprint/);
  request = await manager.open(reader, producer, manifest); await manager.cancel(reader, request.requestId);
  await assert.rejects(manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content }));
  request = await manager.open(reader, producer, manifest); allowed = false;
  await assert.rejects(collect(manager.read(reader, request.requestId)), /revoked/);
});

test('enforces per-node capacity and expires abandoned transfers', async () => {
  let clock = 0;
  const manager = new EvidenceTransferBuffer(async () => {}, () => clock);
  const first = await manager.open(reader, producer, manifest);
  await manager.open(reader, producer, manifest);
  await assert.rejects(manager.open(reader, producer, manifest), /capacity/);
  clock = 30_001;
  await assert.rejects(manager.push(producer, { ...first, outputId: manifest.outputId, sequence: 0, bytes: content }), /unavailable/);
  await manager.open(reader, producer, manifest);
  manager.close();
});

test('cancellation interrupts an active verified stream', async () => {
  const manager = new EvidenceTransferBuffer(async () => {});
  const request = await manager.open(reader, producer, manifest);
  const large = Buffer.alloc(65537, 65);
  await manager.cancel(reader, request.requestId);
  const largeManifest = { ...manifest, sizeBytes: large.length, sha256: createHash('sha256').update(large).digest('hex') };
  const largeRequest = await manager.open(reader, producer, largeManifest);
  await manager.push(producer, { ...largeRequest, outputId: manifest.outputId, sequence: 0, bytes: large.subarray(0, 65536) });
  await manager.push(producer, { ...largeRequest, outputId: manifest.outputId, sequence: 1, bytes: large.subarray(65536) });
  await manager.finish(producer, { ...largeRequest, outputId: manifest.outputId, sequence: 2 });
  const stream = manager.read(reader, largeRequest.requestId);
  assert.equal((await stream.next()).value?.length, 65536);
  await manager.cancel(reader, largeRequest.requestId);
  await assert.rejects(stream.next(), /expired or cancelled/);
  manager.close();
});

test('rejects fragmented uploads that could bypass memory bounds', async () => {
  const manager = new EvidenceTransferBuffer(async () => {});
  const request = await manager.open(reader, producer, manifest);
  await assert.rejects(manager.push(producer, { ...request, outputId: manifest.outputId, sequence: 0, bytes: content.subarray(0, 1) }), /invalid/);
  manager.close();
});
