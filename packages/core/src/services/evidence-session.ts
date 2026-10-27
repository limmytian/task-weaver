import { Readable } from 'node:stream';
import { createAttachmentService } from './attachments';
import { and, eq, gt, ne } from 'drizzle-orm';
import { activityLog, daemons, requirements, workflowOutputs, type Database } from '@task-weaver/db';
import { AuthorizationError, NotFoundError, ValidationError, type EvidenceNodeDemand, type VerifiedRequestContext } from '@task-weaver/contracts';
import { EvidenceHandshake, type RegisteredLocalEvidence } from './evidence-handshake';
import { EvidenceTransferBuffer, type EvidenceManifest, type EvidenceProducer, type EvidenceTransferPrincipal } from './evidence-transfer';
import { requireResource, resourceAuthority } from './resource-authorization';

type Session = { output: RegisteredLocalEvidence; reader: EvidenceTransferPrincipal; purpose: EvidenceNodeDemand['purpose']; expiresAt: number; state: 'pending' | 'streaming' | 'verified' | 'failed'; failure?: 'missing' | 'changed' | 'unsupported' | 'too_large'; bufferId?: string; bufferNonce?: string };
const principal = (context: VerifiedRequestContext): EvidenceTransferPrincipal => ({ actorId: context.actor.id, credentialId: `${context.credential.kind}:${context.credential.id}` });
const principalKey = (value: EvidenceTransferPrincipal) => `${value.actorId}:${value.credentialId}`;

/** Server process-local authenticated evidence coordination; no filesystem access. */
export class EvidenceSessionService {
  private readonly sessions = new Map<string, Session>();
  private readonly contexts = new Map<string, { value: VerifiedRequestContext; expiresAt: number }>();
  private readonly handshake: EvidenceHandshake;
  private readonly buffer: EvidenceTransferBuffer;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database, private readonly now = Date.now) {
    this.handshake = new EvidenceHandshake((side, who, output, purpose) => this.authorize(side, who, output, purpose), now);
    this.buffer = new EvidenceTransferBuffer(async (side, who, manifest) => {
      const session = this.sessions.get(manifest.transferId);
      if (session && (session.output.outputId !== manifest.outputId || session.purpose !== manifest.purpose || (side === 'reader' ? principalKey(session.reader) !== principalKey(who) : session.output.producerActorId !== who.actorId || session.output.daemonId !== (who as EvidenceProducer).daemonId))) throw new AuthorizationError();
      if (!session) throw new AuthorizationError();
      await this.authorize(side, who, session.output, session.purpose);
    }, now);
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  private remember(context: VerifiedRequestContext) {
    this.sweep();
    if (context.credential.kind === 'delegation') throw new AuthorizationError();
    const key = principalKey(principal(context));
    if (!this.contexts.has(key) && this.contexts.size >= 128) throw new ValidationError('Evidence capacity reached');
    this.contexts.set(key, { value: context, expiresAt: this.now() + 60_000 });
    return principal(context);
  }
  private sweep() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
    for (const [key, item] of this.contexts) if (item.expiresAt <= this.now()) this.contexts.delete(key);
  }
  private async authorize(side: 'reader' | 'producer', who: EvidenceTransferPrincipal | EvidenceProducer, expected: RegisteredLocalEvidence, purpose: EvidenceNodeDemand['purpose']) {
    const context = this.contexts.get(principalKey(who))?.value;
    if (!context) throw new AuthorizationError();
    const authority = await resourceAuthority(this.db, context);
    if (authority.bounds) throw new AuthorizationError();
    await requireResource(this.db, authority, 'requirement', expected.requirementId, side === 'reader' && purpose === 'promotion' ? 'resource.write' : 'resource.read');
    const output = await this.db.query.workflowOutputs.findFirst({ where: and(eq(workflowOutputs.id, expected.outputId), eq(workflowOutputs.requirementId, expected.requirementId)) });
    if (!output || output.type !== 'local' || output.availability !== 'available' || output.nodeId !== expected.nodeId || output.relativePath !== expected.relativePath || output.sizeBytes !== expected.sizeBytes || output.sha256 !== expected.sha256 || output.nodePublicKey !== expected.nodePublicKey || output.createdBy !== expected.producerActorId) throw new NotFoundError('Evidence is unavailable');
    if (side === 'producer') {
      const producer = who as EvidenceProducer;
      const daemon = await this.db.query.daemons.findFirst({ where: eq(daemons.id, producer.daemonId) });
      if (context.credential.kind !== 'api_key' || authority.actor.type !== 'agent' || !daemon || daemon.id !== expected.daemonId || daemon.actorId !== authority.actor.id || daemon.actorType !== authority.actor.type || daemon.nodeId !== expected.nodeId || daemon.status === 'offline') throw new AuthorizationError();
    }
  }
  private async producer(context: VerifiedRequestContext, daemonId: string): Promise<EvidenceProducer> {
    const authority = await resourceAuthority(this.db, context);
    const daemon = await this.db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
    if (context.credential.kind !== 'api_key' || authority.actor.type !== 'agent' || !daemon || daemon.actorId !== authority.actor.id || daemon.actorType !== authority.actor.type || !daemon.nodeId || daemon.status === 'offline') throw new AuthorizationError();
    return { ...this.remember(context), daemonId, nodeId: daemon.nodeId };
  }
  async open(context: VerifiedRequestContext, requirementId: string, outputId: string, purpose: EvidenceNodeDemand['purpose']) {
    const authority = await resourceAuthority(this.db, context);
    await requireResource(this.db, authority, 'requirement', requirementId, purpose === 'promotion' ? 'resource.write' : 'resource.read');
    const reader = this.remember(context);
    const requirement = await this.db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
    const output = await this.db.query.workflowOutputs.findFirst({ where: and(eq(workflowOutputs.id, outputId), eq(workflowOutputs.requirementId, requirementId)) });
    if (!requirement || !output || output.type !== 'local' || output.availability !== 'available' || !output.nodeId || !output.relativePath || output.sizeBytes === null || !output.sha256 || !output.nodePublicKey || output.createdByType !== 'agent') throw new NotFoundError('Evidence is unavailable');
    const candidates = await this.db.query.daemons.findMany({ where: and(eq(daemons.nodeId, output.nodeId), eq(daemons.actorId, output.createdBy), ne(daemons.status, 'offline'), gt(daemons.lastHeartbeatAt, new Date(this.now() - 90_000))) });
    const daemon = candidates.find(item => item.capabilities?.includes('evidence-read-v1'));
    if (!daemon) throw new NotFoundError('Evidence producer is offline or unsupported');
    const binding: RegisteredLocalEvidence = { outputId, projectId: requirement.projectId, requirementId, nodeId: output.nodeId, relativePath: output.relativePath, sizeBytes: output.sizeBytes, sha256: output.sha256, nodePublicKey: output.nodePublicKey, daemonId: daemon.id, producerActorId: output.createdBy };
    const opened = await this.handshake.open(reader, binding, purpose);
    this.sessions.set(opened.requestId, { output: binding, reader, purpose, expiresAt: Date.parse(opened.expiresAt), state: 'pending' });
    try { await this.audit(context, binding, 'evidence.read_requested', { purpose }); }
    catch (error) { this.sessions.delete(opened.requestId); await this.handshake.cancel(reader, opened.requestId); throw error; }
    return opened;
  }
  private async audit(context: VerifiedRequestContext, output: RegisteredLocalEvidence, action: string, metadata: Record<string, unknown>) {
    await this.db.insert(activityLog).values({ entityType: 'requirement', entityId: output.requirementId, action, actorId: context.actor.id, actorType: context.actor.type, metadata: { outputId: output.outputId, ...metadata } });
  }
  async poll(context: VerifiedRequestContext, daemonId: string) { return this.handshake.poll(await this.producer(context, daemonId)); }
  async claim(context: VerifiedRequestContext, daemonId: string, requestId: string, proof: string) {
    const producer = await this.producer(context, daemonId); const session = this.sessions.get(requestId);
    if (!session || session.state !== 'pending') throw new NotFoundError('Evidence request is unavailable');
    const result = await this.handshake.prove(producer, requestId, proof);
    const manifest: EvidenceManifest = { transferId: requestId, outputId: session.output.outputId, projectId: session.output.projectId, requirementId: session.output.requirementId, nodeId: session.output.nodeId, sizeBytes: session.output.sizeBytes, sha256: session.output.sha256, purpose: session.purpose };
    const buffer = await this.buffer.open(session.reader, producer, manifest);
    session.bufferId = buffer.requestId; session.bufferNonce = buffer.nonce; session.state = 'streaming';
    return result;
  }
  async push(context: VerifiedRequestContext, daemonId: string, requestId: string, sequence: number, bytes: Uint8Array) {
    const producer = await this.producer(context, daemonId); const session = this.sessions.get(requestId);
    if (!session?.bufferId || !session.bufferNonce || session.state !== 'streaming') throw new NotFoundError('Evidence request is unavailable');
    await this.handshake.recheck(producer, requestId);
    return this.buffer.push(producer, { requestId: session.bufferId, nonce: session.bufferNonce, outputId: session.output.outputId, sequence, bytes });
  }
  async finish(context: VerifiedRequestContext, daemonId: string, requestId: string, sequence: number) {
    const producer = await this.producer(context, daemonId); const session = this.sessions.get(requestId);
    if (!session?.bufferId || !session.bufferNonce || session.state !== 'streaming') throw new NotFoundError('Evidence request is unavailable');
    await this.handshake.recheck(producer, requestId);
    await this.buffer.finish(producer, { requestId: session.bufferId, nonce: session.bufferNonce, outputId: session.output.outputId, sequence });
    await this.audit(context, session.output, 'evidence.verified', { sizeBytes: session.output.sizeBytes });
    session.state = 'verified'; this.handshake.release(requestId); return { verified: true };
  }
  async fail(context: VerifiedRequestContext, daemonId: string, requestId: string, failure: 'missing' | 'changed' | 'unsupported' | 'too_large') {
    const producer = await this.producer(context, daemonId); const session = this.sessions.get(requestId);
    if (!session || session.state !== 'streaming') throw new NotFoundError('Evidence request is unavailable');
    await this.handshake.recheck(producer, requestId);
    if (session.bufferId) await this.buffer.cancel(session.reader, session.bufferId);
    session.bufferId = undefined; session.bufferNonce = undefined;
    session.state = 'failed'; session.failure = failure; this.handshake.release(requestId);
    await this.audit(context, session.output, 'evidence.read_failed', { failure });
    return { recorded: true };
  }
  async status(context: VerifiedRequestContext, requestId: string) {
    const reader = principal(context); this.sweep(); const session = this.sessions.get(requestId);
    if (!session || principalKey(reader) !== principalKey(session.reader)) throw new NotFoundError('Evidence request is unavailable');
    this.remember(context);
    await this.authorize('reader', reader, session.output, session.purpose);
    return { state: session.state, failure: session.failure ?? null, expiresAt: session.expiresAt, sizeBytes: session.output.sizeBytes, sha256: session.output.sha256 };
  }
  async *read(context: VerifiedRequestContext, requestId: string, signal?: AbortSignal) {
    const reader = principal(context); this.sweep(); const session = this.sessions.get(requestId);
    if (!session?.bufferId || session.state !== 'verified' || principalKey(reader) !== principalKey(session.reader)) throw new NotFoundError('Evidence request is unavailable');
    this.remember(context);
    try { yield* this.buffer.read(reader, session.bufferId, signal); }
    finally { this.sessions.delete(requestId); }
  }
  async promote(context: VerifiedRequestContext, requestId: string) {
    const reader = principal(context); this.sweep(); const session = this.sessions.get(requestId);
    if (!session?.bufferId || session.state !== 'verified' || session.purpose !== 'promotion' || principalKey(reader) !== principalKey(session.reader)) throw new NotFoundError('Evidence request is unavailable');
    await this.status(context, requestId);
    const input = Readable.from(this.read(context, requestId));
    return createAttachmentService(context).promoteEvidence(this.db, session.output.requirementId, session.output.outputId, input);
  }
  async cancel(context: VerifiedRequestContext, requestId: string) {
    const reader = principal(context); const session = this.sessions.get(requestId);
    if (!session || principalKey(reader) !== principalKey(session.reader)) throw new NotFoundError('Evidence request is unavailable');
    this.remember(context);
    if (session.state === 'pending' || session.state === 'streaming') await this.handshake.cancel(reader, requestId);
    if (session.bufferId) await this.buffer.cancel(reader, session.bufferId);
    this.sessions.delete(requestId);
  }
  close() { clearInterval(this.timer); this.handshake.close(); this.buffer.close(); this.sessions.clear(); this.contexts.clear(); }
}
