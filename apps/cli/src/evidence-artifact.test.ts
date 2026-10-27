import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVerifiedEvidence, EvidenceArtifactError } from './evidence-artifact';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
test('verified snapshots are confined, immutable and fully hashed', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-evidence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lane'));
  await writeFile(join(root, 'lane', 'file'), 'verified');
  const manifest = { relativePath: 'lane/file', sizeBytes: 8, sha256: digest('verified') };
  const evidence = await openVerifiedEvidence(root, manifest);
  await writeFile(join(root, 'lane', 'file'), 'modified');
  const chunks: Buffer[] = [];
  for await (const chunk of evidence.createReadStream()) chunks.push(Buffer.from(chunk));
  await evidence.close();
  assert.equal(Buffer.concat(chunks).toString(), 'verified');
  await assert.rejects(openVerifiedEvidence(root, manifest), (error: unknown) => error instanceof EvidenceArtifactError && error.state === 'changed');
  await assert.rejects(openVerifiedEvidence(root, { ...manifest, relativePath: '../outside' }), EvidenceArtifactError);
  await assert.rejects(openVerifiedEvidence(root, { ...manifest, relativePath: 'lane/%2e%2e/file' }), EvidenceArtifactError);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  await assert.rejects(openVerifiedEvidence(alias, manifest), EvidenceArtifactError);
  await symlink('/etc', join(root, 'escape'));
  await assert.rejects(openVerifiedEvidence(root, { ...manifest, relativePath: 'escape/passwd' }), EvidenceArtifactError);
  await symlink('/etc/passwd', join(root, 'lane', 'link'));
  await assert.rejects(openVerifiedEvidence(root, { ...manifest, relativePath: 'lane/link' }), EvidenceArtifactError);
  assert.equal(await readFile(join(root, 'lane', 'file'), 'utf8'), 'modified');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openVerifiedEvidence(root, manifest, controller.signal));
});

test('concurrent directory-to-symlink replacement cannot escape the evidence root', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-evidence-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'tw-evidence-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await mkdir(join(root, 'lane')); await writeFile(join(root, 'lane', 'file'), 'verified'); await writeFile(join(outside, 'file'), 'external');
  const manifest = { relativePath: 'lane/file', sizeBytes: 8, sha256: digest('verified') };
  const swaps = (async () => { for (let i = 0; i < 80; i++) {
    await rename(join(root, 'lane'), join(root, 'parked')); await symlink(outside, join(root, 'lane'));
    await rm(join(root, 'lane')); await rename(join(root, 'parked'), join(root, 'lane'));
  } })();
  for (let i = 0; i < 80; i++) {
    try {
      const snapshot = await openVerifiedEvidence(root, manifest); const chunks: Buffer[] = [];
      try { for await (const chunk of snapshot.createReadStream()) chunks.push(Buffer.from(chunk)); }
      finally { await snapshot.close(); }
      assert.equal(Buffer.concat(chunks).toString(), 'verified');
    } catch (error) { assert.ok(error instanceof EvidenceArtifactError); }
  }
  await swaps;
});

test('verified evidence streams a multi-chunk artifact with its complete digest', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-evidence-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(root, 'large.bin'), bytes);
  const started = performance.now();
  const evidence = await openVerifiedEvidence(root, { relativePath: 'large.bin', sizeBytes: bytes.length, sha256 });
  const hash = createHash('sha256'); let received = 0;
  try { for await (const chunk of evidence.createReadStream()) { received += chunk.length; hash.update(chunk); } }
  finally { await evidence.close(); }
  assert.equal(received, bytes.length); assert.equal(hash.digest('hex'), sha256);
  console.log(`Verified local evidence: ${received} bytes, ${Math.round(performance.now() - started)} ms`);
});
