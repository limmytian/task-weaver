import { eq } from 'drizzle-orm';
import { daemons, requirementClaims, requirements, type Database } from '@task-weaver/db';
import { AuthorizationError, type DaemonRole } from '@task-weaver/contracts';
import { requireResource, type ResourceAuthority } from './resource-authorization';

/** Caller-supplied daemon and worker labels only select a persisted, currently held lease. */
export async function requireDaemonLease(db: Database, authority: ResourceAuthority, requirementId: string, input: { daemonId?: string; leaseGeneration?: number; runId?: string; workerIndex?: string | number }, role?: DaemonRole) {
  if (authority.bounds || authority.actor.type !== 'agent' || !input.daemonId || !Number.isInteger(input.leaseGeneration)) throw new AuthorizationError();
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, input.daemonId) });
  if (!daemon || daemon.actorId !== authority.actor.id || daemon.actorType !== 'agent' || (role && daemon.role !== role)) throw new AuthorizationError();
  const permission = daemon.role === 'reviewer' ? 'execution.review' : daemon.role === 'merger' ? 'execution.merge' : 'execution.run';
  await requireResource(db, authority, 'requirement', requirementId, permission);
  await requireResource(db, authority, 'requirement', requirementId);
  if (daemon.role === 'executor') await requireResource(db, authority, 'requirement', requirementId, 'resource.write');
  const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
  const claim = await db.query.requirementClaims.findFirst({ where: eq(requirementClaims.requirementId, requirementId) });
  if (!requirement || !claim || ['done', 'cancelled', 'archived'].includes(requirement.status)
    || claim.claimedBy !== authority.actor.id || claim.claimedByType !== 'agent' || claim.daemonId !== daemon.id
    || claim.generation !== input.leaseGeneration || requirement.leaseGeneration !== claim.generation || claim.expiresAt <= new Date()
    || (input.runId !== undefined && input.runId !== claim.id)
    || (input.workerIndex !== undefined && String(input.workerIndex) !== claim.workerIndex)) throw new AuthorizationError();
  return { daemon, claim, requirement };
}
