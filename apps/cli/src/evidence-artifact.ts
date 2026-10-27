import { constants } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceLimits } from '@task-weaver/contracts';

export class EvidenceArtifactError extends Error {
  constructor(readonly state: 'unsupported' | 'missing' | 'changed' | 'too_large', message: string) { super(message); }
}

type RegisteredArtifact = { relativePath: string; sizeBytes: number; sha256: string };
/**
 * Internal producer primitive. The caller must obtain the manifest from an
 * authenticated, output-bound demand and enforce node ownership and concurrency.
 * Only Linux exposes the descriptor-relative traversal used here; other hosts
 * fail closed until an equivalent race-resistant primitive is available.
 */
export async function openVerifiedEvidence(root: string, manifest: RegisteredArtifact, signal?: AbortSignal) {
  if (process.platform !== 'linux') throw new EvidenceArtifactError('unsupported', 'Secure evidence reads are unavailable on this platform');
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0 || manifest.sizeBytes > evidenceLimits.verifiedArtifactBytes) throw new EvidenceArtifactError('too_large', 'Artifact exceeds the verification limit');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new EvidenceArtifactError('changed', 'Artifact fingerprint is invalid');
  const parts = manifest.relativePath.split('/');
  if (!manifest.relativePath || manifest.relativePath.startsWith('/') || manifest.relativePath.includes('\\') || manifest.relativePath.includes('%') || parts.some(part => !part || part === '.' || part === '..')) throw new EvidenceArtifactError('changed', 'Artifact path is invalid');
  const deadline = AbortSignal.timeout(evidenceLimits.requestDurationMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const handles: FileHandle[] = [];
  let snapshot: FileHandle | undefined;
  const abort = () => combined.throwIfAborted();
  try {
    abort();
    let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(directory);
    for (const part of parts.slice(0, -1)) {
      abort();
      directory = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(directory);
    }
    const source = await open(`/proc/self/fd/${directory.fd}/${parts[parts.length - 1]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(source);
    const stat = await source.stat();
    if (!stat.isFile() || stat.size !== manifest.sizeBytes) throw new EvidenceArtifactError('changed', 'Artifact type or size differs from its manifest');
    const temporaryPath = join(tmpdir(), `tw-evidence-${randomUUID()}`);
    snapshot = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await unlink(temporaryPath);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      abort();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > manifest.sizeBytes || total > evidenceLimits.verifiedArtifactBytes) throw new EvidenceArtifactError('changed', 'Artifact size changed during verification');
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        abort();
        const written = await snapshot.write(buffer, offset, bytesRead - offset, total - bytesRead + offset);
        if (!written.bytesWritten) throw new Error('Unable to save verified snapshot');
        offset += written.bytesWritten;
      }
    }
    if (total !== manifest.sizeBytes || hash.digest('hex') !== manifest.sha256) throw new EvidenceArtifactError('changed', 'Artifact fingerprint does not match its manifest');
    abort();
    const verified = snapshot;
    snapshot = undefined;
    return { sizeBytes: total, sha256: manifest.sha256, createReadStream: () => verified.createReadStream({ start: 0, autoClose: false, signal: combined }), close: () => verified.close() };
  } catch (error) {
    if (error instanceof EvidenceArtifactError || combined.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EvidenceArtifactError('missing', 'Artifact is missing');
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new EvidenceArtifactError('changed', 'Artifact path is not a regular confined file');
    throw error;
  } finally {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    if (snapshot) await snapshot.close().catch(() => {});
  }
}
