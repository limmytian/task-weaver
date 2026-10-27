import { randomBytes, randomUUID } from 'node:crypto';
import { evidenceLimits, evidenceNodeDemandSchema, ValidationError, type EvidenceNodeDemand } from '@task-weaver/contracts';
import { verifyEvidenceNodeProof } from './evidence-proof';
import type { EvidenceProducer, EvidenceTransferPrincipal } from './evidence-transfer';

/** This record must be resolved from an authorized registered output, not caller input. */
export type RegisteredLocalEvidence = {
  outputId: string; projectId: string; requirementId: string; nodeId: string; relativePath: string;
  sizeBytes: number; sha256: string; nodePublicKey: string; daemonId: string; producerActorId: string;
};
type Session = { demand: EvidenceNodeDemand; output: RegisteredLocalEvidence; reader: EvidenceTransferPrincipal; claimedBy?: EvidenceProducer };

/**
 * The adapter authenticates each principal and supplies live authorization and
 * immutable-manifest checks. The path is released only after node-key proof.
 * Requests are process-local and must be routed back to their creating process.
 */
export class EvidenceHandshake {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly authorize: (side: 'reader' | 'producer', principal: EvidenceTransferPrincipal | EvidenceProducer, output: RegisteredLocalEvidence, purpose: EvidenceNodeDemand['purpose']) => Promise<void>, private readonly now = Date.now) {
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  private sweep() { for (const [id, session] of this.sessions) if (Date.parse(session.demand.expiresAt) <= this.now()) this.sessions.delete(id); }
  private async active(id: string) {
    this.sweep(); const session = this.sessions.get(id);
    if (!session) throw new ValidationError('Evidence request is unavailable');
    try { await this.authorize('reader', session.reader, session.output, session.demand.purpose); }
    catch (error) { this.sessions.delete(id); throw error; }
    if (this.sessions.get(id) !== session || Date.parse(session.demand.expiresAt) <= this.now()) { this.sessions.delete(id); throw new ValidationError('Evidence request expired'); }
    return session;
  }
  async open(reader: EvidenceTransferPrincipal, output: RegisteredLocalEvidence, purpose: EvidenceNodeDemand['purpose']) {
    await this.authorize('reader', reader, output, purpose); this.sweep();
    if (this.sessions.size >= 32 || [...this.sessions.values()].filter(session => session.output.nodeId === output.nodeId).length >= evidenceLimits.nodeConcurrency) throw new ValidationError('Evidence capacity reached');
    const demand = evidenceNodeDemandSchema.parse({ requestId: randomUUID(), outputId: output.outputId, projectId: output.projectId, requirementId: output.requirementId, daemonId: output.daemonId, nodeId: output.nodeId, nonce: randomBytes(32).toString('hex'), purpose, sizeBytes: output.sizeBytes, sha256: output.sha256, expiresAt: new Date(this.now() + evidenceLimits.requestDurationMs).toISOString() });
    this.sessions.set(demand.requestId, { demand, output: { ...output }, reader: { ...reader } });
    return { requestId: demand.requestId, expiresAt: demand.expiresAt };
  }
  async poll(producer: EvidenceProducer) {
    this.sweep(); const items: EvidenceNodeDemand[] = [];
    for (const [id, current] of this.sessions) {
      if (current.claimedBy || current.output.daemonId !== producer.daemonId || current.output.nodeId !== producer.nodeId || current.output.producerActorId !== producer.actorId) continue;
      try { const session = await this.active(id); await this.authorize('producer', producer, session.output, session.demand.purpose); if (this.sessions.get(id) === session) items.push(session.demand); }
      catch { this.sessions.delete(id); }
    }
    return items;
  }
  async prove(producer: EvidenceProducer, requestId: string, signature: string) {
    const session = await this.active(requestId);
    if (session.claimedBy || session.output.daemonId !== producer.daemonId || session.output.nodeId !== producer.nodeId || session.output.producerActorId !== producer.actorId) throw new ValidationError('Evidence request is unavailable');
    await this.authorize('producer', producer, session.output, session.demand.purpose);
    if (this.sessions.get(requestId) !== session || session.claimedBy || !verifyEvidenceNodeProof(session.demand, session.output.nodePublicKey, signature, this.now())) throw new ValidationError('Evidence proof is invalid or expired');
    session.claimedBy = { ...producer };
    return { demand: session.demand, relativePath: session.output.relativePath };
  }
  async recheck(producer: EvidenceProducer, requestId: string) {
    const session = await this.active(requestId); const claimed = session.claimedBy;
    if (!claimed || claimed.actorId !== producer.actorId || claimed.credentialId !== producer.credentialId || claimed.daemonId !== producer.daemonId || claimed.nodeId !== producer.nodeId) throw new ValidationError('Evidence request is unavailable');
    try { await this.authorize('producer', producer, session.output, session.demand.purpose); }
    catch (error) { this.sessions.delete(requestId); throw error; }
  }
  async cancel(reader: EvidenceTransferPrincipal, requestId: string) {
    const session = await this.active(requestId);
    if (session.reader.actorId !== reader.actorId || session.reader.credentialId !== reader.credentialId) throw new ValidationError('Evidence request is unavailable');
    await this.authorize('reader', reader, session.output, session.demand.purpose); this.sessions.delete(requestId);
  }
  close() { clearInterval(this.timer); this.sessions.clear(); }
}
