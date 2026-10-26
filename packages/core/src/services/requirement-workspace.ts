import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { type Database, requirements, tasks, repositories, requirementRepositories, requirementDependencies } from "@task-weaver/db";
import { requirementWorkspaceSchema } from "@task-weaver/contracts";
import type { z } from "zod";

type Predicates = { requirements?: SQL; tasks?: SQL; repositories?: SQL };
const terminal = new Set(["archived", "cancelled", "done"]);
const priorities: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const statuses: Record<string, number> = { in_progress: 0, in_review: 1, ready_to_merge: 2, approved: 3, draft: 4, done: 5, cancelled: 6, archived: 7 };

/** Complete authorized metadata supports global facets; bodies and task rows never enter this read. */
export async function getRequirementWorkspace(db: Database, input: z.infer<typeof requirementWorkspaceSchema>, predicates: Predicates = {}) {
  const days = input.completedWithinDays ?? 14;
  const where = and(eq(requirements.projectId, input.projectId), predicates.requirements,
    days > 0 ? sql`(${requirements.status} NOT IN ('done','cancelled','archived') OR ${requirements.updatedAt} >= ${new Date(Date.now() - days * 86_400_000).toISOString()})` : undefined);
  const metadata = await db.select({ id: requirements.id, title: requirements.title, status: requirements.status,
    priority: requirements.priority, tags: requirements.tags, expectedAt: requirements.expectedAt, createdAt: requirements.createdAt }).from(requirements).where(where);
  const counts = await db.select({ id: tasks.requirementId, total: sql<number>`count(*)::int`,
    done: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'done')::int`,
    inProgress: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'in_progress')::int`,
    inReview: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'in_review')::int` })
    .from(tasks).innerJoin(requirements, eq(tasks.requirementId, requirements.id))
    .where(and(where, predicates.tasks)).groupBy(tasks.requirementId);
  const byId = new Map(counts.map(row => [row.id, row]));
  const empty = { total: 0, done: 0, inProgress: 0, inReview: 0 };
  const [repositoryCount] = await db.select({ count: sql<number>`count(distinct ${repositories.id})::int` })
    .from(requirementRepositories).innerJoin(requirements, eq(requirementRepositories.requirementId, requirements.id))
    .innerJoin(repositories, eq(requirementRepositories.repositoryId, repositories.id))
    .where(and(where, predicates.repositories));
  const now = Date.now();
  const summary = { active: metadata.filter(row => !terminal.has(row.status)).length,
    done: metadata.filter(row => row.status === "done").length,
    dueSoon: metadata.filter(row => !terminal.has(row.status) && row.expectedAt && new Date(row.expectedAt).getTime() >= now && new Date(row.expectedAt).getTime() <= now + 7 * 86_400_000).length,
    repositoryCount: repositoryCount?.count ?? 0,
    taskProgress: `${counts.reduce((sum, row) => sum + row.done, 0)}/${counts.reduce((sum, row) => sum + row.total, 0)}` };
  const tags = [...new Set(metadata.flatMap(row => row.tags ?? []))].sort();
  const matching = metadata.filter(row => (input.archived ? row.status === "archived" : row.status !== "archived") && (!input.tag || row.tags?.includes(input.tag)));
  matching.sort((a, b) => {
    const delta = input.sortBy === "priority" ? (priorities[a.priority] ?? 9) - (priorities[b.priority] ?? 9)
      : input.sortBy === "status" ? (statuses[a.status] ?? 9) - (statuses[b.status] ?? 9)
      : input.sortBy === "expected" ? (a.expectedAt ? new Date(a.expectedAt).getTime() : Infinity) - (b.expectedAt ? new Date(b.expectedAt).getTime() : Infinity)
      : b.createdAt.getTime() - a.createdAt.getTime();
    return (input.reverse ? -1 : 1) * (Number.isNaN(delta) || delta === 0 ? a.id.localeCompare(b.id) : delta);
  });
  const total = matching.length, pageCount = Math.ceil(total / input.pageSize);
  const page = Math.min(input.page, Math.max(1, pageCount));
  const selected = matching.slice((page - 1) * input.pageSize, page * input.pageSize);
  const ids = selected.map(row => row.id);
  const rows = ids.length && !input.graph ? await db.select({ id: requirements.id,
    description: sql<string | null>`left(${requirements.description}, 320)` }).from(requirements).where(and(where, inArray(requirements.id, ids))) : [];
  const links = ids.length && !input.graph ? await db.select({ requirementId: requirementRepositories.requirementId,
    repository: { id: repositories.id, displayName: repositories.displayName, canonicalKey: repositories.canonicalKey, provider: repositories.provider } })
    .from(requirementRepositories).innerJoin(repositories, eq(requirementRepositories.repositoryId, repositories.id))
    .where(and(inArray(requirementRepositories.requirementId, ids), predicates.repositories)) : [];
  // Both dependency endpoints are filtered before edges leave the transaction. Keep recent-window external nodes.
  const dependencies = input.graph && metadata.length ? await db.select({ id: requirementDependencies.id,
    requirementId: requirementDependencies.requirementId, dependsOnRequirementId: requirementDependencies.dependsOnRequirementId,
    type: requirementDependencies.type }).from(requirementDependencies)
    .where(and(inArray(requirementDependencies.requirementId, metadata.map(row => row.id)),
      sql`${requirementDependencies.dependsOnRequirementId} IN (SELECT ${requirements.id} FROM ${requirements} WHERE ${and(eq(requirements.projectId, input.projectId), predicates.requirements)})`)) : [];
  const externalIds = [...new Set(dependencies.map(row => row.dependsOnRequirementId))].filter(id => !metadata.some(row => row.id === id));
  const external = externalIds.length ? await db.select({ id: requirements.id, title: requirements.title, status: requirements.status, priority: requirements.priority })
    .from(requirements).where(and(inArray(requirements.id, externalIds), eq(requirements.projectId, input.projectId), predicates.requirements)) : [];
  return { items: input.graph ? [] : selected.map(row => ({ ...row, description: rows.find(item => item.id === row.id)?.description ?? null,
    taskCounts: byId.get(row.id) ?? empty, repositories: links.filter(link => link.requirementId === row.id).map(({ repository }) => ({ repository })) })),
    total, page, pageSize: input.pageSize, pageCount, summary, tags,
    archivedCount: metadata.filter(row => row.status === "archived").length,
    graph: input.graph ? { nodes: [...metadata.map(row => ({ id: row.id, title: row.title, status: row.status, priority: row.priority,
      external: false, taskCounts: byId.get(row.id) ?? empty })), ...external.map(row => ({ ...row, external: true, taskCounts: empty }))], edges: dependencies } : null };
}
