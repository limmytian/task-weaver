import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { authActors, executionDelegations } from '@task-weaver/db';
import type { AuthDatabase } from './auth-principals';

/** Policy changes end old execution grants permanently, even if membership is restored later. */
export async function revokeActorExecutions(db: AuthDatabase, actorId: string, projectId?: string) {
  const managed = await db.select({ id: authActors.id }).from(authActors).where(eq(authActors.managedByActorId, actorId));
  const actors = [actorId, ...managed.map(actor => actor.id)];
  await db.update(executionDelegations).set({ revokedAt: new Date() }).where(and(
    isNull(executionDelegations.revokedAt),
    or(inArray(executionDelegations.actorId, actors), eq(executionDelegations.initiatorActorId, actorId)),
    projectId ? eq(executionDelegations.projectId, projectId) : undefined,
  ));
}
