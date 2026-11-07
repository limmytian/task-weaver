import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { daemons, managedChildObservations, requirementClaims, requirements, type Database } from '@task-weaver/db';
import { AuthorizationError, ConflictError, type VerifiedRequestContext } from '@task-weaver/contracts';
import { lockIdentityLifecycle } from './auth-security';
import { requireResource, resourceAuthority } from './resource-authorization';

const identity = z.object({ requirementId: z.string().uuid(), runId: z.string().uuid(), leaseGeneration: z.number().int().nonnegative(), pid: z.number().int().positive(), processIdentity: z.string().min(1).max(512) }).strict();
const exit = identity.extend({ status: z.number().int().nullable(), signal: z.string().regex(/^SIG[A-Z0-9]{1,16}$/).nullable() }).strict().refine(v => (v.status === null) !== (v.signal === null));

/** Only the unbounded authenticated supervisor can bind and report its directly spawned child. */
export function createManagedChildObservationService(context: VerifiedRequestContext) {
  async function write(db: Database, daemonId: string, raw: unknown, isExit: boolean) {
    const input = isExit ? exit.parse(raw) : identity.parse(raw);
    return db.transaction(async transaction => {
      await lockIdentityLifecycle(transaction);
      const tx = transaction as unknown as Database;
      const authority = await resourceAuthority(tx, context);
      const [daemon] = await tx.select().from(daemons).where(eq(daemons.id, daemonId)).for('share');
      if (authority.bounds || authority.actor.type !== 'agent' || context.credential.kind !== 'api_key' || !daemon || daemon.actorType !== 'agent' || daemon.actorId !== authority.actor.id || daemon.role !== 'executor' || daemon.registrationCredentialId !== context.credential.id) throw new AuthorizationError();
      await requireResource(tx, authority, 'requirement', input.requirementId, 'execution.run');
      await requireResource(tx, authority, 'requirement', input.requirementId, 'resource.write');
      // Lock in the same order as lease mutations, so a concurrent rotation cannot
      // validate against a snapshot that ceases to be current before insertion.
      const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, input.requirementId)).for('update');
      const [claim] = await tx.select().from(requirementClaims).where(eq(requirementClaims.requirementId, input.requirementId)).for('update');
      if (!requirement || ['done', 'cancelled', 'archived'].includes(requirement.status) || !claim || claim.id !== input.runId || claim.daemonId !== daemonId || claim.claimedBy !== authority.actor.id || claim.claimedByType !== 'agent' || claim.generation !== input.leaseGeneration || requirement.leaseGeneration !== input.leaseGeneration || claim.expiresAt <= new Date()) throw new AuthorizationError();
      const [existing] = await tx.select().from(managedChildObservations).where(eq(managedChildObservations.runId, input.runId)).for('update');
      if (!isExit) {
        if (existing) throw new ConflictError('Spawn already bound', requirement.planRevision);
        const [row] = await tx.insert(managedChildObservations).values({ ...identity.parse(input), daemonId }).returning();
        return row!;
      }
      const report = exit.parse(input);
      if (!existing || existing.requirementId !== input.requirementId || existing.daemonId !== daemonId || existing.leaseGeneration !== input.leaseGeneration || existing.pid !== input.pid || existing.processIdentity !== input.processIdentity || existing.exitedAt) throw new ConflictError('Spawn binding missing, mismatched, or already exited', requirement.planRevision);
      const [row] = await tx.update(managedChildObservations).set({ exitedAt: new Date(), exitStatus: report.status, signal: report.signal }).where(and(eq(managedChildObservations.runId, input.runId))).returning();
      return row!;
    });
  }
  return { bind: (db: Database, daemonId: string, input: unknown) => write(db, daemonId, input, false), exit: (db: Database, daemonId: string, input: unknown) => write(db, daemonId, input, true) };
}
