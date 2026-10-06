import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { requirements, repositories, tasks, daemons, daemonWorkerProgress, daemonWorkerProgressHistory, type Database } from "@task-weaver/db";
import { projectPredicate, taskResourcePredicate, type ResourceAuthority } from "./resource-authorization";
import { repositoryPredicate } from "./repository-authorization";

export type MetadataReadScope = { requirement: SQL; daemon: SQL; progress: SQL; history: SQL };

/** Quarantine inconsistent nested metadata rather than attribute it to another project. */
export function metadataReadScope(db: Database, authority: ResourceAuthority, projectId?: string): MetadataReadScope {
  const visibleRepos = db.select({ id: repositories.id }).from(repositories).where(repositoryPredicate(authority));
  const visibleTasks = db.select({ id: tasks.id }).from(tasks).where(taskResourcePredicate(authority));
  const reqIds = db.select({ id: requirements.id }).from(requirements).where(and(
    projectPredicate(authority, "audit.read", requirements.projectId), projectId ? eq(requirements.projectId, projectId) : undefined,
    sql`NOT EXISTS (SELECT 1 FROM tasks t WHERE t.requirement_id = ${requirements.id} AND (t.project_id IS DISTINCT FROM ${requirements.projectId} OR t.scope <> 'project' OR t.id NOT IN (${visibleTasks})))`,
    sql`NOT EXISTS (SELECT 1 FROM requirement_repositories rr WHERE rr.requirement_id = ${requirements.id} AND rr.repository_id NOT IN (${visibleRepos}))`,
    sql`NOT EXISTS (SELECT 1 FROM requirement_dependencies d JOIN requirements upstream ON upstream.id = d.depends_on_requirement_id WHERE d.requirement_id = ${requirements.id} AND upstream.project_id <> ${requirements.projectId})`,
    sql`NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.task_id JOIN tasks upstream ON upstream.id = d.depends_on_task_id WHERE t.requirement_id = ${requirements.id} AND (upstream.project_id IS DISTINCT FROM ${requirements.projectId} OR upstream.id NOT IN (${visibleTasks})))`,
  ));
  const validProgress = (table: typeof daemonWorkerProgress | typeof daemonWorkerProgressHistory) => and(
    inArray(table.requirementId, reqIds),
    sql`(${table.currentTaskId} IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${table.currentTaskId} AND t.requirement_id = ${table.requirementId}))`,
    sql`(${table.lastCompletedTaskId} IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${table.lastCompletedTaskId} AND t.requirement_id = ${table.requirementId}))`,
    sql`(${table.executionSliceId} IS NULL OR EXISTS (SELECT 1 FROM execution_slices s WHERE s.id = ${table.executionSliceId} AND s.requirement_id = ${table.requirementId}))`,
  )!;
  const progress = validProgress(daemonWorkerProgress), history = validProgress(daemonWorkerProgressHistory);
  const daemonIds = db.select({ id: daemonWorkerProgress.daemonId }).from(daemonWorkerProgress).where(progress);
  const historicalDaemonIds = db.select({ id: daemonWorkerProgressHistory.daemonId }).from(daemonWorkerProgressHistory).where(history);
  return { requirement: inArray(requirements.id, reqIds), progress: inArray(daemonWorkerProgress.id, db.select({ id: daemonWorkerProgress.id }).from(daemonWorkerProgress).where(progress)), history: inArray(daemonWorkerProgressHistory.id, db.select({ id: daemonWorkerProgressHistory.id }).from(daemonWorkerProgressHistory).where(history)), daemon: or(inArray(daemons.id, daemonIds), inArray(daemons.id, historicalDaemonIds))! };
}
