import { and, eq } from 'drizzle-orm';
import { executionSynchronizations, requirementRepositories, type Database } from '@task-weaver/db';
import { ValidationError } from '@task-weaver/contracts';

export async function requireExecutionSynchronization(db: Database, requirementId: string, runId: string) {
  const links = await db.select({ id: requirementRepositories.repositoryId }).from(requirementRepositories).where(eq(requirementRepositories.requirementId, requirementId));
  for (const link of links) {
    const sync = await db.query.executionSynchronizations.findFirst({ where: and(eq(executionSynchronizations.runId, runId), eq(executionSynchronizations.repositoryId, link.id)) });
    if (!sync) throw new ValidationError('Synchronize every target repository through the daemon Git capability before substantive progress or delivery');
  }
}
