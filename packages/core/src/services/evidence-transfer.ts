import { createHash, randomBytes, randomUUID, type Hash } from 'node:crypto';
import { evidenceLimits, ValidationError } from '@task-weaver/contracts';

/** The transport adapter supplies verified identities and rechecks their live authority on every call. */
export type EvidenceTransferPrincipal = { actorId: string; credentialId: string };
export type EvidenceProducer = EvidenceTransferPrincipal & { daemonId: string; nodeId: string };
export type EvidenceManifest = { outputId: string; projectId: string; requirementId: string; nodeId: string; purpose: 'preview' | 'download' | 'promotion'; sizeBytes: number; sha256: string };
type Transfer = { id: string; nonce: string; manifest: EvidenceManifest; reader: EvidenceTransferPrincipal; producer: EvidenceProducer; expiresAt: number; next: number; received: number; hash: Hash; chunks: Buffer[]; state: 'pending' | 'complete' | 'reading' };

/**
 * Bounded in-process transfer state. The API adapter must route a request back
 * to its originating process and provide checks backed by current credentials,
 * output registration and daemon/node ownership. No execution lease is used.
 */
export class EvidenceTransferBuffer {
  private readonly transfers = new Map<string, Transfer>();
  private reservedBytes = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly verify: (side: 'reader' | 'producer', principal: EvidenceTransferPrincipal | EvidenceProducer, manifest: EvidenceManifest) => Promise<void>, private readonly now = Date.now) {
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  private remove(id: string) { const item = this.transfers.get(id); if (item) { this.reservedBytes -= item.manifest.sizeBytes; this.transfers.delete(id); item.chunks.length = 0; } }
  private sweep() { for (const item of this.transfers.values()) if (item.expiresAt <= this.now()) this.remove(item.id); }
  private async current(id: string, side: 'reader' | 'producer', principal: EvidenceTransferPrincipal | EvidenceProducer) {
    this.sweep(); const item = this.transfers.get(id);
    if (!item) throw new ValidationError('Evidence request is unavailable');
    const expected = side === 'reader' ? item.reader : item.producer;
    if (expected.actorId !== principal.actorId || expected.credentialId !== principal.credentialId || side === 'producer' && ((principal as EvidenceProducer).daemonId !== item.producer.daemonId || (principal as EvidenceProducer).nodeId !== item.producer.nodeId)) throw new ValidationError('Evidence request is unavailable');
    try { await this.verify(side, principal, item.manifest); } catch (error) { this.remove(id); throw error; }
    if (this.transfers.get(id) !== item || item.expiresAt <= this.now()) { this.remove(id); throw new ValidationError('Evidence request expired'); }
    return item;
  }
  async open(reader: EvidenceTransferPrincipal, producer: EvidenceProducer, manifest: EvidenceManifest) {
    this.sweep();
    if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0 || manifest.sizeBytes > evidenceLimits.verifiedArtifactBytes || !/^[a-f0-9]{64}$/.test(manifest.sha256) || producer.nodeId !== manifest.nodeId) throw new ValidationError('Evidence manifest is unavailable');
    await this.verify('reader', reader, manifest); await this.verify('producer', producer, manifest);
    this.sweep();
    if ([...this.transfers.values()].filter(item => item.producer.nodeId === producer.nodeId).length >= evidenceLimits.nodeConcurrency || this.reservedBytes + manifest.sizeBytes > 2 * evidenceLimits.verifiedArtifactBytes || this.transfers.size >= 32) throw new ValidationError('Evidence capacity reached');
    const id = randomUUID(), nonce = randomBytes(32).toString('hex'), expiresAt = this.now() + evidenceLimits.requestDurationMs;
    this.transfers.set(id, { id, nonce, manifest: { ...manifest }, reader: { ...reader }, producer: { ...producer }, expiresAt, next: 0, received: 0, hash: createHash('sha256'), chunks: [], state: 'pending' });
    this.reservedBytes += manifest.sizeBytes;
    return { requestId: id, nonce, expiresAt };
  }
  async push(producer: EvidenceProducer, input: { requestId: string; outputId: string; nonce: string; sequence: number; bytes: Uint8Array }) {
    const item = await this.current(input.requestId, 'producer', producer);
    if (item.state !== 'pending' || item.manifest.outputId !== input.outputId || item.nonce !== input.nonce || input.sequence !== item.next || input.bytes.byteLength > evidenceLimits.chunkBytes || !input.bytes.byteLength || item.received + input.bytes.byteLength > item.manifest.sizeBytes) { this.remove(item.id); throw new ValidationError('Evidence frame is invalid or replayed'); }
    const bytes = Buffer.from(input.bytes); item.chunks.push(bytes); item.hash.update(bytes); item.received += bytes.length; item.next++;
    return { nextSequence: item.next };
  }
  async finish(producer: EvidenceProducer, input: { requestId: string; outputId: string; nonce: string; sequence: number }) {
    const item = await this.current(input.requestId, 'producer', producer);
    if (item.state !== 'pending' || item.manifest.outputId !== input.outputId || item.nonce !== input.nonce || input.sequence !== item.next || item.received !== item.manifest.sizeBytes || item.hash.digest('hex') !== item.manifest.sha256) { this.remove(item.id); throw new ValidationError('Evidence fingerprint or sequence does not match'); }
    item.state = 'complete'; return { verified: true };
  }
  async *read(reader: EvidenceTransferPrincipal, id: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const item = await this.current(id, 'reader', reader);
    if (item.state !== 'complete') throw new ValidationError('Evidence is not verified');
    item.state = 'reading';
    try {
      for (const chunk of item.chunks) { signal?.throwIfAborted(); await this.current(id, 'reader', reader); yield Buffer.from(chunk); }
      if (this.transfers.get(id) !== item || item.expiresAt <= this.now()) throw new ValidationError('Evidence request expired or cancelled');
    } finally { this.remove(id); }
  }
  async cancel(reader: EvidenceTransferPrincipal, id: string) { await this.current(id, 'reader', reader); this.remove(id); }
  close() { clearInterval(this.timer); for (const id of this.transfers.keys()) this.remove(id); }
}
