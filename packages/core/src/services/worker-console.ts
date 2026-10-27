import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { daemons, tasks, requirements, requirementClaims, type Database } from '@task-weaver/db';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError, consoleBatchSchema, consoleOpenSchema, consoleLimits, type ConsoleTarget, type ConsoleBatch, type ConsoleDemand, type VerifiedRequestContext } from '@task-weaver/contracts';
import { resourceAuthority, requireResource } from './resource-authorization';
import { requireDaemonLease } from './daemon-lease-authorization';
import { lockIdentityLifecycle } from './auth-security';
import { assertRunNotInvalidated } from './planning-impact';

interface Session {
  id: string; target: ConsoleTarget; daemonId: string; viewer: VerifiedRequestContext;
  follow: boolean; requestedAt: number; expiresAt: number; deadline: number; revision: number; after: number;
  captureId?: string; batch?: ConsoleBatch; accepted: boolean; lastResponse: number;
}
/** No durable sink or event emitter belongs in this service. All bodies die with its process. */
export class WorkerConsoleService {
  private sessions = new Map<string, Session>();
  readonly boot = randomUUID();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly route: string, private readonly now = Date.now) { this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref(); }
  private sweep() { for (const [id, s] of this.sessions) if (s.expiresAt <= this.now() || s.deadline <= this.now() || !s.lastResponse && s.requestedAt + consoleLimits.snapshotMs <= this.now()) this.sessions.delete(id); }
  private async viewer(db: Database, s: Session) {
    try {
      const authority = await resourceAuthority(db, s.viewer);
      if (authority.bounds || authority.actor.type !== 'human') throw new AuthorizationError();
      await requireResource(db, authority, 'requirement', s.target.requirementId);
      await requireResource(db, authority, 'requirement', s.target.requirementId, 'audit.read');
      const claim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, s.target.requirementId) });
      const req = await db.query.requirements.findFirst({ where: eq(requirements.id, s.target.requirementId) });
      if (!claim || !req || claim.id !== s.target.runId || claim.daemonId !== s.daemonId || claim.workerIndex !== String(s.target.workerIndex)
        || claim.generation !== s.target.leaseGeneration || req.leaseGeneration !== claim.generation || claim.expiresAt.getTime() <= this.now()
        || ['done', 'cancelled', 'archived'].includes(req.status)) throw new AuthorizationError();
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, s.target.taskId) });
      if (!task || task.requirementId !== req.id) throw new AuthorizationError();
      await assertRunNotInvalidated(db, claim.id);
    } catch (error) { this.sessions.delete(s.id); throw error; }
  }
  private active(s: Session) {
    if (this.sessions.get(s.id) !== s || s.expiresAt <= this.now() || s.deadline <= this.now() || !s.lastResponse && s.requestedAt + consoleLimits.snapshotMs <= this.now()) {
      this.sessions.delete(s.id); throw new NotFoundError('Console request expired or cancelled');
    }
  }
  private owned(id: string, context: VerifiedRequestContext) {
    this.sweep(); const s = this.sessions.get(id);
    if (!s) throw new NotFoundError('Console session expired or history unavailable');
    if (s.viewer.credential.kind !== context.credential.kind || s.viewer.credential.id !== context.credential.id || s.viewer.actor.id !== context.actor.id) throw new AuthorizationError();
    return s;
  }
  private async openUnlocked(db: Database, context: VerifiedRequestContext, raw: unknown) {
    this.sweep(); const input = consoleOpenSchema.parse(raw);
    if (this.sessions.size >= consoleLimits.sessions) throw new ValidationError('Console observer capacity reached');
    const matching = [...this.sessions.values()].filter(s => s.target.runId === input.runId && s.viewer.credential.id === context.credential.id);
    if (matching.length >= consoleLimits.viewersPerRun) throw new ValidationError('Console viewer limit reached');
    const claim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.id, input.runId) });
    if (!claim?.daemonId) throw new NotFoundError('Current worker run unavailable');
    const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, claim.daemonId) });
    if (daemon?.role !== 'executor') throw new ValidationError('Console capture is unavailable for this daemon role');
    const now = this.now();
    const s: Session = { id: `${this.route}.${this.boot}.${randomUUID()}`, target: { requirementId: input.requirementId, taskId: input.taskId, runId: input.runId, workerIndex: input.workerIndex, leaseGeneration: input.leaseGeneration }, daemonId: claim.daemonId, viewer: context, follow: input.follow, requestedAt: now, expiresAt: now + consoleLimits.snapshotMs, deadline: now + consoleLimits.sessionMs, revision: 0, after: 0, accepted: false, lastResponse: 0 };
    await this.viewer(db, s); this.sessions.set(s.id, s);
    return { id: s.id, expiresAt: s.expiresAt, deadline: s.deadline };
  }
  private async readUnlocked(db: Database, context: VerifiedRequestContext, id: string, follow: boolean) {
    const s = this.owned(id, context); await this.viewer(db, s); this.active(s);
    // A snapshot is immutable after its first response. Explicit follow starts another request.
    if (follow && !s.follow) throw new ValidationError('Open a new session to follow');
    if (s.follow) s.expiresAt = Math.min(this.now() + consoleLimits.followMs, s.deadline);
    const batch = s.batch; s.batch = undefined;
    return { id, state: batch ? 'connected' : s.lastResponse ? 'waiting' : 'requesting', batch: batch ?? null, expiresAt: s.expiresAt, deadline: s.deadline, target: s.target };
  }
  private async cancelUnlocked(db: Database, context: VerifiedRequestContext, id: string) {
    const s = this.owned(id, context); this.sessions.delete(id); await this.viewer(db, s); return { closed: true };
  }
  private async demandsUnlocked(db: Database, context: VerifiedRequestContext, daemonId: string): Promise<ConsoleDemand[]> {
    this.sweep();
    const authority = await resourceAuthority(db, context);
    const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
    if (authority.bounds || authority.actor.type !== 'agent' || context.credential.kind !== 'api_key' || daemon?.actorId !== authority.actor.id) throw new AuthorizationError();
    const items: ConsoleDemand[] = [];
    for (const s of this.sessions.values()) {
      if (s.daemonId !== daemonId || !s.follow && s.accepted) continue;
      try {
        await this.viewer(db, s); this.active(s);
        await requireDaemonLease(db, authority, s.target.requirementId, { ...s.target, daemonId });
        items.push({ ...s.target, id: s.id, revision: s.revision, after: s.after, expiresAt: Math.min(s.expiresAt, s.deadline) });
      } catch { this.sessions.delete(s.id); }
    }
    return items;
  }
  private async respondUnlocked(db: Database, context: VerifiedRequestContext, daemonId: string, id: string, raw: unknown) {
    this.sweep(); const s = this.sessions.get(id);
    if (!s || s.daemonId !== daemonId) throw new NotFoundError('Console request unavailable');
    const batch = consoleBatchSchema.parse(raw);
    const authority = await resourceAuthority(db, context);
    if (context.credential.kind !== 'api_key') throw new AuthorizationError();
    await requireDaemonLease(db, authority, s.target.requirementId, { ...s.target, daemonId });
    await this.viewer(db, s); this.active(s);
    if (s.expiresAt <= this.now() || s.deadline <= this.now() || !s.lastResponse && s.requestedAt + consoleLimits.snapshotMs <= this.now() || batch.revision !== s.revision || !s.follow && s.accepted) throw new ConflictError('Console request expired or superseded', s.revision);
    if (s.captureId && s.captureId !== batch.captureId) { this.sessions.delete(id); throw new NotFoundError('Console capture ended; reopen the current worker'); }
    s.captureId = batch.captureId;
    if (s.lastResponse && this.now() - s.lastResponse < 500) throw new ValidationError('Console response rate exceeded');
    let previous = Math.max(s.after, batch.firstSequence - 1);
    for (const frame of batch.frames) {
      if (frame.sequence !== previous + 1 || Buffer.byteLength(frame.text) > consoleLimits.frameBytes) throw new ValidationError('Invalid console sequence or frame size');
      previous = frame.sequence;
    }
    if (batch.nextSequence !== previous + 1) throw new ValidationError('Invalid console cursor');
    // Latest batch replaces a slow reader's response. Its sequence discontinuity is visible.
    if (batch.frames.length || !s.batch) s.batch = { ...batch, truncated: batch.truncated || batch.firstSequence > s.after + 1 || Boolean(s.batch?.frames.length) };
    else { s.batch.truncated ||= batch.truncated; s.batch.unavailable ||= batch.unavailable; }
    s.after = batch.nextSequence - 1; s.revision++; s.accepted = true; s.lastResponse = this.now();
    return { accepted: true };
  }
  private secure<T>(db: Database, work: (tx: Database) => Promise<T>) {
    return db.transaction(async tx => { await lockIdentityLifecycle(tx); return work(tx as unknown as Database); });
  }
  open(db: Database, context: VerifiedRequestContext, raw: unknown) { return this.secure(db, tx => this.openUnlocked(tx, context, raw)); }
  read(db: Database, context: VerifiedRequestContext, id: string, follow: boolean) { return this.secure(db, tx => this.readUnlocked(tx, context, id, follow)); }
  cancel(db: Database, context: VerifiedRequestContext, id: string) { return this.secure(db, tx => this.cancelUnlocked(tx, context, id)); }
  demands(db: Database, context: VerifiedRequestContext, daemonId: string) { return this.secure(db, tx => this.demandsUnlocked(tx, context, daemonId)); }
  respond(db: Database, context: VerifiedRequestContext, daemonId: string, id: string, raw: unknown) { return this.secure(db, tx => this.respondUnlocked(tx, context, daemonId, id, raw)); }
  close() { clearInterval(this.timer); this.sessions.clear(); }
}
