import { eq, inArray, or, sql } from 'drizzle-orm';
import { authActors, daemons, tasks, repositories, type Database } from '@task-weaver/db';
import { AuthorizationError, NotFoundError, type AuthorizationPermission, type DaemonRole } from '@task-weaver/contracts';
import { canAccessResource, requireResource, type ResourceAuthority } from './resource-authorization';
import { loadActivePrincipal, loadPrincipalGrants } from './auth-principals';
import { repositoryPredicate } from './repository-authorization';

function rolePermission(role: DaemonRole): AuthorizationPermission {
  return role === 'reviewer' ? 'execution.review' : role === 'merger' ? 'execution.merge' : 'execution.run';
}
function executionProjects(authority: ResourceAuthority, role: DaemonRole): string[] {
  return authority.grants.flatMap(grant => grant.scope === 'project'
    && canAccessResource(authority, { projectId: grant.projectId }, rolePermission(role))
    && canAccessResource(authority, { projectId: grant.projectId }, 'resource.read')
    && (role !== 'executor' || canAccessResource(authority, { projectId: grant.projectId }, 'resource.write')) ? [grant.projectId] : []);
}

/** Applied inside the live identity transaction, before candidate pagination or claims. */
function acquisitionFilter(db: Database, authority: ResourceAuthority, role: DaemonRole, taskQueue: boolean) {
  const projects = executionProjects(authority, role);
  if (!projects.length) return sql`false`;
  const visibleRepos = db.select({ id: repositories.id }).from(repositories).where(repositoryPredicate(authority));
  const requirementId = taskQueue ? sql`t.requirement_id` : sql`r.id`;
  const projectId = taskQueue ? sql`t.project_id` : sql`r.project_id`;
  return sql`${inArray(projectId, projects)}
    AND EXISTS (SELECT 1 FROM requirements ar WHERE ar.id = ${requirementId} AND ar.project_id = ${projectId})
    AND NOT EXISTS (SELECT 1 FROM tasks at WHERE at.requirement_id = ${requirementId} AND (at.scope <> 'project' OR at.project_id IS DISTINCT FROM ${projectId} OR at.personal_owner_id IS NOT NULL OR at.personal_owner_type IS NOT NULL OR (at.execution_slice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution_slices xs WHERE xs.id = at.execution_slice_id AND xs.requirement_id = ${requirementId}))))
    AND NOT EXISTS (SELECT 1 FROM requirement_repositories rr WHERE rr.requirement_id = ${requirementId} AND rr.repository_id NOT IN (${visibleRepos}))
    AND NOT EXISTS (SELECT 1 FROM requirement_dependencies rd JOIN requirements upstream ON upstream.id = rd.depends_on_requirement_id WHERE rd.requirement_id = ${requirementId} AND upstream.project_id <> ${projectId})
    AND NOT EXISTS (SELECT 1 FROM task_dependencies td JOIN tasks current ON current.id = td.task_id JOIN tasks upstream ON upstream.id = td.depends_on_task_id WHERE current.requirement_id = ${requirementId} AND (upstream.scope <> 'project' OR upstream.project_id IS DISTINCT FROM ${projectId}))`;
}

export async function authorizeDaemonOperation(db: Database, authority: ResourceAuthority, group: 'daemon' | 'progress', name: string, call: any[]): Promise<boolean> {
  if (group === 'daemon' && name === 'listExecutorDaemons') {
    const managed = db.select({ id: sql<string>`${authActors.id}::text` }).from(authActors).where(eq(authActors.managedByActorId, authority.actor.id));
    const candidates = await db.select({ id: daemons.id }).from(daemons).where(or(eq(daemons.actorId, authority.actor.id), inArray(daemons.actorId, managed))).limit(100);
    const visible: string[] = [];
    for (const candidate of candidates) {
      try { await authorizeDaemonOperation(db, authority, 'daemon', 'listExecutorProfiles', [db, candidate.id]); visible.push(candidate.id); }
      catch (error) { if (!(error instanceof AuthorizationError || error instanceof NotFoundError)) throw error; }
    }
    call[1] = inArray(daemons.id, visible);
    return true;
  }
  if (group === 'daemon' && name === 'registerDaemon') {
    const input = call[1];
    if (authority.actor.type !== 'agent' || !executionProjects(authority, input.role).length) throw new AuthorizationError();
    if (input.id) {
      const existing = await db.query.daemons.findFirst({ where: eq(daemons.id, input.id) });
      if (existing && (existing.actorId !== authority.actor.id || existing.actorType !== 'agent' || existing.role !== input.role)) throw new NotFoundError('Daemon not found');
    }
    return true;
  }
  const supported = group === 'daemon'
    ? ['heartbeatDaemon', 'updateDaemonStatus', 'requestDaemonControl', 'applyTask', 'applyRequirement', 'applyReview', 'applyMerge', 'explainRequirementEligibility', 'reportExecutorObservation', 'listExecutorProfiles', 'requestExecutorRefresh', 'requestExecutorResume', 'listExecutorAvailabilityHistory']
    : ['reportWorkerProgress', 'reconcileWorkerRun'];
  if (!supported.includes(name)) return false;
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, call[1]) });
  if (!daemon || !daemon.actorId || daemon.actorType !== 'agent') throw new NotFoundError('Daemon not found');
  const owner = await loadActivePrincipal(db, daemon.actorId);
  if (owner.type !== 'agent') throw new NotFoundError('Daemon not found');
  const controls = ['requestDaemonControl', 'requestExecutorRefresh', 'requestExecutorResume'].includes(name);
  const inspection = ['listExecutorProfiles', 'listExecutorAvailabilityHistory'].includes(name);
  if (daemon.actorId !== authority.actor.id && !((controls || inspection) && owner.managedByActorId === authority.actor.id)) throw new NotFoundError('Daemon not found');
  if (!controls && !inspection && (authority.actor.type !== 'agent' || !executionProjects(authority, daemon.role).length)) throw new AuthorizationError();
  if (inspection && daemon.actorId === authority.actor.id) {
    if (!executionProjects(authority, daemon.role).length) throw new AuthorizationError();
  } else if (controls || inspection) {
    const ownerGrants = await loadPrincipalGrants(db, owner.id);
    const projects = ownerGrants.flatMap(grant => grant.scope === 'project' && grant.permissions.includes(rolePermission(daemon.role)) ? [grant.projectId] : []);
    if (!projects.length || projects.some(projectId => !canAccessResource(authority, { projectId }, controls ? 'project.manage' : 'audit.read'))) throw new AuthorizationError();
  }
  const acquisition = { applyTask: [4, 'executor', true], applyRequirement: [6, 'executor', true], explainRequirementEligibility: [5, 'executor', true], applyReview: [5, 'reviewer', false], applyMerge: [5, 'merger', false] } as const;
  if (name in acquisition) {
    const [index, role, taskQueue] = acquisition[name as keyof typeof acquisition];
    if (daemon.role !== role) throw new AuthorizationError();
    if (call[2]) await requireResource(db, authority, 'project', call[2], rolePermission(role));
    call[index] = acquisitionFilter(db, authority, role, taskQueue);
  }
  const workerInput = group === 'progress' ? [call[2]] : name === 'updateDaemonStatus' ? call[4] ?? [] : [];
  for (const worker of workerInput) {
    if (!worker.requirementId && [worker.currentTaskId, worker.taskId, worker.lastCompletedTaskId].some(Boolean)) throw new AuthorizationError();
    if (worker.requirementId) {
      const requirement = await requireResource(db, authority, 'requirement', worker.requirementId, rolePermission(daemon.role));
      for (const taskId of [worker.currentTaskId, worker.taskId, worker.lastCompletedTaskId]) {
        if (!taskId) continue;
        const task = await requireResource(db, authority, 'task', taskId, rolePermission(daemon.role));
        if (task.projectId !== requirement.projectId) throw new AuthorizationError();
        const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
        if (row?.requirementId !== worker.requirementId) throw new AuthorizationError();
      }
    }
  }
  if (name === 'updateDaemonStatus') for (const taskId of call[3] ?? []) await requireResource(db, authority, 'task', taskId, rolePermission(daemon.role));
  // Persisted active targets must remain authorized even when the caller omits worker hints.
  if (!controls) for (const taskId of daemon.activeTaskIds) await requireResource(db, authority, 'task', taskId, rolePermission(daemon.role));
  if (!controls) for (const worker of Array.isArray(daemon.activeWorkerStates) ? daemon.activeWorkerStates as any[] : []) {
    if (worker.requirementId) await requireResource(db, authority, 'requirement', worker.requirementId, rolePermission(daemon.role));
  }
  return true;
}
