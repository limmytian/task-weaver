import type { SQL } from "drizzle-orm";
import { eq, sql, and, gte, inArray, or } from "drizzle-orm";
import {
  type Database,
  projects,
  tasks,
  requirements,
  documents,
  documentLinks,
  documentTaskLinks,
  documentRequirementLinks,
  taskDependencies,
  requirementDependencies,
  requirementClaims,
  activityLog,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type { CreateProjectInput, UpdateProjectInput, ListProjectsInput } from "@task-weaver/contracts";
import { NotFoundError } from "@task-weaver/contracts";

export async function createProject(
  db: Database,
  input: CreateProjectInput,
  actor: Actor,
) {
  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      description: input.description,
      createdBy: actor.id,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "project",
    entityId: project!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
  });

  return project!;
}

export async function getProject(db: Database, id: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, id),
  });
  if (!project) throw new NotFoundError("Project not found");
  return project;
}

type PagedProjectList = {
  items: unknown[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  view: "summary" | "full"
}

export function listProjects(
  db: Database,
  filters: ListProjectsInput & { view: "summary" | "full" },
  authorizedPredicate?: SQL,
): Promise<PagedProjectList>

export function listProjects(
  db: Database,
  filters?: ListProjectsInput,
  authorizedPredicate?: SQL,
): Promise<Array<typeof projects.$inferSelect>>

export async function listProjects(
  db: Database,
  filters: ListProjectsInput = {},
  authorizedPredicate?: SQL,
): Promise<PagedProjectList | Array<typeof projects.$inferSelect>> {
  const conditions = [authorizedPredicate];
  if (filters.status) {
    conditions.push(eq(projects.status, filters.status));
  }
  if (filters.query) {
    const likePattern = `%${filters.query}%`;
    conditions.push(sql`(
      ${projects.name} ILIKE ${likePattern}
      OR COALESCE(${projects.description}, '') ILIKE ${likePattern}
    )`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  if (filters.view === undefined) {
    return db.query.projects.findMany({
      where,
      orderBy: (p, { desc }) => [desc(p.updatedAt)],
    });
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? (filters.view === "full" ? 10 : 20);
  const offset = (page - 1) * pageSize;
  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(where);

  if (filters.view === "summary") {
    const [items, totalRows] = await Promise.all([
      db.query.projects.findMany({
        where,
        columns: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: (p, { desc }) => [desc(p.updatedAt)],
        limit: pageSize,
        offset,
      }),
      totalQuery,
    ]);
    const total = totalRows[0]?.count ?? 0;
    return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize), view: "summary" };
  }

  const [items, totalRows] = await Promise.all([
    db.query.projects.findMany({
      where,
      orderBy: (p, { desc }) => [desc(p.updatedAt)],
      limit: pageSize,
      offset,
    }),
    totalQuery,
  ]);
  const total = totalRows[0]?.count ?? 0;
  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize), view: "full" };
}


export async function updateProject(
  db: Database,
  id: string,
  input: UpdateProjectInput,
  actor: Actor,
) {
  const existing = await getProject(db, id);

  if (input.status === "archived") {
    await deleteRequirementClaimsForProject(db, id);
  }

  const [updated] = await db
    .update(projects)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "project",
    entityId: id,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { changes: input, previous: { name: existing.name, status: existing.status } },
  });

  return updated!;
}

export async function getProjectCounts(
  db: Database,
  projectIds: string[],
  authorizedPredicate?: SQL,
  authorizedTaskPredicate?: SQL,
) {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({
      projectId: projects.id,
      taskCount: sql<number>`(SELECT count(*)::int FROM tasks WHERE tasks.project_id = "projects"."id" AND ${authorizedTaskPredicate ?? sql`true`})`.as("task_count"),
      requirementCount: sql<number>`(SELECT count(*)::int FROM requirements WHERE requirements.project_id = "projects"."id")`.as("requirement_count"),
    })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), authorizedPredicate));
  return rows;
}

export async function getProjectStats(db: Database, id: string) {
  await getProject(db, id);

  // Task counts by status
  const statusRows = await db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, id))
    .groupBy(tasks.status);

  const byStatus: Record<string, number> = {};
  let totalTasks = 0;
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
    totalTasks += row.count;
  }

  // Task counts by priority
  const priorityRows = await db
    .select({
      priority: tasks.priority,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, id))
    .groupBy(tasks.priority);

  const byPriority: Record<string, number> = {};
  for (const row of priorityRows) {
    byPriority[row.priority] = row.count;
  }

  // Blocked tasks: tasks that have a "blocks" dependency on an incomplete task
  const [blockedRow] = await db
    .select({ count: sql<number>`count(DISTINCT ${taskDependencies.taskId})::int` })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(
      and(
        eq(taskDependencies.type, "blocks"),
        sql`${tasks.status} NOT IN ('done', 'cancelled')`,
      ),
    );

  // Average completion time (days) for done tasks
  const [avgRow] = await db
    .select({
      avgDays: sql<number | null>`avg(extract(epoch from (${tasks.completedAt} - ${tasks.createdAt})) / 86400)`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, id), eq(tasks.status, "done"), sql`${tasks.completedAt} IS NOT NULL`));

  // Requirement progress
  const reqProgress = await db
    .select({
      id: requirements.id,
      title: requirements.title,
      status: requirements.status,
      totalTasks: sql<number>`count(${tasks.id})::int`,
      completedTasks: sql<number>`count(CASE WHEN ${tasks.status} = 'done' THEN 1 END)::int`,
    })
    .from(requirements)
    .leftJoin(tasks, eq(tasks.requirementId, requirements.id))
    .where(eq(requirements.projectId, id))
    .groupBy(requirements.id, requirements.title, requirements.status);

  return {
    totalTasks,
    byStatus,
    byPriority,
    blockedTasks: blockedRow?.count ?? 0,
    avgCompletionDays: avgRow?.avgDays ? Math.round(avgRow.avgDays * 10) / 10 : null,
    requirementProgress: reqProgress,
  };
}

export interface ProjectHealthDashboard {
  projectId: string;
  projectName: string;
  healthScore: number;
  breakdown: {
    completionRate: number;
    overdueRate: number;
    activityTrend: number;
    requirementCoverage: number;
    velocityTrend: number;
  };
  overdueTasks: { id: string; title: string; expectedAt: string; assignee: string | null }[];
  staleTasks: { id: string; title: string; updatedAt: string; status: string }[];
  unassignedTasks: number;
  requirementsWithoutTasks: { id: string; title: string }[];
  velocity: { week: string; completed: number }[];
  activitySummary: {
    last7Days: number;
    previous7Days: number;
    trend: "up" | "down" | "stable";
  };
  documentCount: number;
}

export async function getProjectHealthDashboard(
  db: Database,
  id: string,
): Promise<ProjectHealthDashboard> {
  const project = await getProject(db, id);
  const now = new Date();

  // --- Task aggregates ---
  const allTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assignee: tasks.assignee,
      expectedAt: tasks.expectedAt,
      completedAt: tasks.completedAt,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.projectId, id));

  const totalTasks = allTasks.length;
  const doneTasks = allTasks.filter((t) => t.status === "done").length;
  const cancelledTasks = allTasks.filter((t) => t.status === "cancelled").length;
  const activeTasks = totalTasks - cancelledTasks;

  // Completion rate (excluding cancelled)
  const completionRate = activeTasks > 0 ? doneTasks / activeTasks : 1;

  // Overdue tasks: have expectedAt in the past, not done/cancelled
  const overdueTasks = allTasks.filter(
    (t) =>
      t.expectedAt &&
      t.expectedAt < now &&
      t.status !== "done" &&
      t.status !== "cancelled",
  );
  const overdueRate = activeTasks > 0 ? 1 - overdueTasks.length / activeTasks : 1;

  // Stale tasks: in_progress or in_review but not updated in 7+ days
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const staleTasks = allTasks.filter(
    (t) =>
      (t.status === "in_progress" || t.status === "in_review") &&
      t.updatedAt < sevenDaysAgo,
  );

  // Unassigned active tasks
  const unassignedTasks = allTasks.filter(
    (t) => !t.assignee && t.status !== "done" && t.status !== "cancelled",
  ).length;

  // --- Velocity (tasks completed per week, last 4 weeks) ---
  const velocity: { week: string; completed: number }[] = [];
  for (let i = 3; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);
    weekEnd.setHours(23, 59, 59, 999);

    const completed = allTasks.filter(
      (t) => t.completedAt && t.completedAt >= weekStart && t.completedAt < weekEnd,
    ).length;

    velocity.push({
      week: weekStart.toISOString().slice(0, 10),
      completed,
    });
  }

  // Velocity trend: compare last 2 weeks
  const lastWeekVel = velocity[3]?.completed ?? 0;
  const prevWeekVel = velocity[2]?.completed ?? 0;
  const velocityTrend = prevWeekVel > 0 ? lastWeekVel / prevWeekVel : lastWeekVel > 0 ? 2 : 1;
  const velocityScore = Math.min(velocityTrend, 2) / 2; // normalize to 0-1

  // --- Requirement coverage ---
  const reqRows = await db
    .select({
      id: requirements.id,
      title: requirements.title,
      taskCount: sql<number>`count(${tasks.id})::int`,
    })
    .from(requirements)
    .leftJoin(tasks, eq(tasks.requirementId, requirements.id))
    .where(and(eq(requirements.projectId, id), sql`${requirements.status} != 'cancelled'`))
    .groupBy(requirements.id, requirements.title);

  const requirementsWithoutTasks = reqRows.filter((r) => r.taskCount === 0);
  const totalReqs = reqRows.length;
  const requirementCoverage = totalReqs > 0 ? 1 - requirementsWithoutTasks.length / totalReqs : 1;

  // --- Activity trend (last 7 days vs previous 7 days) ---
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const entityFilter = sql`${activityLog.entityId} IN (
    SELECT id FROM tasks WHERE project_id = ${id}
    UNION SELECT id FROM requirements WHERE project_id = ${id}
    UNION SELECT id FROM documents WHERE project_id = ${id}
    UNION SELECT ${id}::uuid
  )`;
  const [recentRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(and(gte(activityLog.createdAt, sevenDaysAgo), entityFilter));
  const [previousRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(
      and(
        gte(activityLog.createdAt, fourteenDaysAgo),
        sql`${activityLog.createdAt} < ${sevenDaysAgo.toISOString()}::timestamptz`,
        entityFilter,
      ),
    );

  const last7Days = recentRow?.count ?? 0;
  const previous7Days = previousRow?.count ?? 0;
  const activityTrendDir: "up" | "down" | "stable" =
    last7Days > previous7Days * 1.2 ? "up" : last7Days < previous7Days * 0.8 ? "down" : "stable";
  const activityScore = previous7Days > 0 ? Math.min(last7Days / previous7Days, 2) / 2 : last7Days > 0 ? 1 : 0.5;

  // --- Document count ---
  const [docRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.projectId, id));
  const documentCount = docRow?.count ?? 0;

  // --- Health score (weighted composite, 0-100) ---
  const weights = {
    completionRate: 0.30,
    overdueRate: 0.25,
    activityTrend: 0.15,
    requirementCoverage: 0.15,
    velocityTrend: 0.15,
  };

  const healthScore = Math.round(
    (completionRate * weights.completionRate +
      overdueRate * weights.overdueRate +
      activityScore * weights.activityTrend +
      requirementCoverage * weights.requirementCoverage +
      velocityScore * weights.velocityTrend) *
      100,
  );

  return {
    projectId: id,
    projectName: project.name,
    healthScore,
    breakdown: {
      completionRate: Math.round(completionRate * 100),
      overdueRate: Math.round(overdueRate * 100),
      activityTrend: Math.round(activityScore * 100),
      requirementCoverage: Math.round(requirementCoverage * 100),
      velocityTrend: Math.round(velocityScore * 100),
    },
    overdueTasks: overdueTasks.map((t) => ({
      id: t.id,
      title: t.title,
      expectedAt: t.expectedAt!.toISOString().slice(0, 10),
      assignee: t.assignee,
    })),
    staleTasks: staleTasks.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt.toISOString().slice(0, 10),
      status: t.status,
    })),
    unassignedTasks,
    requirementsWithoutTasks: requirementsWithoutTasks.map((r) => ({
      id: r.id,
      title: r.title,
    })),
    velocity,
    activitySummary: {
      last7Days,
      previous7Days,
      trend: activityTrendDir,
    },
    documentCount,
  };
}

export interface KnowledgeGraphNode {
  id: string;
  type: "document" | "task" | "requirement";
  label: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  sourceType: "document" | "task" | "requirement";
  targetType: "document" | "task" | "requirement";
  linkType: string;
}

export interface KnowledgeGraph {
  projectId: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  stats: {
    documentCount: number;
    taskCount: number;
    requirementCount: number;
    edgeCount: number;
    isolatedNodes: number;
  };
}

export async function getKnowledgeGraph(
  db: Database,
  projectId: string,
): Promise<KnowledgeGraph> {
  await getProject(db, projectId);

  // Fetch all nodes in parallel
  const [docList, taskList, reqList] = await Promise.all([
    db
      .select({
        id: documents.id,
        title: documents.title,
        docType: documents.docType,
        tags: documents.tags,
      })
      .from(documents)
      .where(eq(documents.projectId, projectId)),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        requirementId: tasks.requirementId,
        assignee: tasks.assignee,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId)),
    db
      .select({
        id: requirements.id,
        title: requirements.title,
        status: requirements.status,
        priority: requirements.priority,
      })
      .from(requirements)
      .where(eq(requirements.projectId, projectId)),
  ]);

  // Collect all entity IDs for edge filtering
  const docIds = docList.map((d) => d.id);
  const taskIds = taskList.map((t) => t.id);
  const reqIds = reqList.map((r) => r.id);

  // Build nodes
  const nodes: KnowledgeGraphNode[] = [
    ...docList.map((d) => ({
      id: d.id,
      type: "document" as const,
      label: d.title,
      metadata: { docType: d.docType, tags: d.tags },
    })),
    ...taskList.map((t) => ({
      id: t.id,
      type: "task" as const,
      label: t.title,
      metadata: {
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
        requirementId: t.requirementId,
      },
    })),
    ...reqList.map((r) => ({
      id: r.id,
      type: "requirement" as const,
      label: r.title,
      metadata: { status: r.status, priority: r.priority },
    })),
  ];

  const edges: KnowledgeGraphEdge[] = [];

  // Document-to-document links
  if (docIds.length > 0) {
    const docDocLinks = await db
      .select({
        sourceDocId: documentLinks.sourceDocId,
        targetDocId: documentLinks.targetDocId,
        linkType: documentLinks.linkType,
      })
      .from(documentLinks)
      .where(or(inArray(documentLinks.sourceDocId, docIds), inArray(documentLinks.targetDocId, docIds)));

    for (const link of docDocLinks) {
      edges.push({
        source: link.sourceDocId,
        target: link.targetDocId,
        sourceType: "document",
        targetType: "document",
        linkType: link.linkType,
      });
    }
  }

  // Document-to-task links
  if (docIds.length > 0 && taskIds.length > 0) {
    const docTaskLinkRows = await db
      .select({
        documentId: documentTaskLinks.documentId,
        taskId: documentTaskLinks.taskId,
        linkType: documentTaskLinks.linkType,
      })
      .from(documentTaskLinks)
      .where(or(inArray(documentTaskLinks.documentId, docIds), inArray(documentTaskLinks.taskId, taskIds)));

    for (const link of docTaskLinkRows) {
      edges.push({
        source: link.documentId,
        target: link.taskId,
        sourceType: "document",
        targetType: "task",
        linkType: link.linkType,
      });
    }
  }

  // Document-to-requirement links
  if (docIds.length > 0 && reqIds.length > 0) {
    const docReqLinkRows = await db
      .select({
        documentId: documentRequirementLinks.documentId,
        requirementId: documentRequirementLinks.requirementId,
        linkType: documentRequirementLinks.linkType,
      })
      .from(documentRequirementLinks)
      .where(or(inArray(documentRequirementLinks.documentId, docIds), inArray(documentRequirementLinks.requirementId, reqIds)));

    for (const link of docReqLinkRows) {
      edges.push({
        source: link.documentId,
        target: link.requirementId,
        sourceType: "document",
        targetType: "requirement",
        linkType: link.linkType,
      });
    }
  }

  // Task-to-task dependencies
  if (taskIds.length > 0) {
    const taskDepRows = await db
      .select({
        taskId: taskDependencies.taskId,
        dependsOnTaskId: taskDependencies.dependsOnTaskId,
        type: taskDependencies.type,
      })
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, taskIds));

    for (const dep of taskDepRows) {
      edges.push({
        source: dep.taskId,
        target: dep.dependsOnTaskId,
        sourceType: "task",
        targetType: "task",
        linkType: dep.type,
      });
    }
  }

  // Requirement-to-requirement dependencies
  if (reqIds.length > 0) {
    const reqDepRows = await db
      .select({
        requirementId: requirementDependencies.requirementId,
        dependsOnRequirementId: requirementDependencies.dependsOnRequirementId,
        type: requirementDependencies.type,
      })
      .from(requirementDependencies)
      .where(inArray(requirementDependencies.requirementId, reqIds));

    for (const dep of reqDepRows) {
      edges.push({
        source: dep.requirementId,
        target: dep.dependsOnRequirementId,
        sourceType: "requirement",
        targetType: "requirement",
        linkType: dep.type,
      });
    }
  }

  // Implicit requirement-to-task edges (every task belongs to a requirement)
  for (const t of taskList) {
    if (!t.requirementId) continue;
    edges.push({
      source: t.requirementId,
      target: t.id,
      sourceType: "requirement",
      targetType: "task",
      linkType: "contains",
    });
  }

  // Compute isolated nodes (nodes with no edges)
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }
  const isolatedNodes = nodes.filter((n) => !connectedIds.has(n.id)).length;

  return {
    projectId,
    nodes,
    edges,
    stats: {
      documentCount: docList.length,
      taskCount: taskList.length,
      requirementCount: reqList.length,
      edgeCount: edges.length,
      isolatedNodes,
    },
  };
}

export async function togglePin(db: Database, id: string) {
  const project = await getProject(db, id);
  const newPinnedAt = project.pinnedAt ? null : new Date();
  const [updated] = await db
    .update(projects)
    .set({ pinnedAt: newPinnedAt })
    .where(eq(projects.id, id))
    .returning();
  return updated!;
}

export async function listPinnedProjects(db: Database,
  authorizedPredicate?: SQL,
) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.status, "active"),
      authorizedPredicate,
      sql`${projects.pinnedAt} IS NOT NULL`,
    ),
    orderBy: (p, { desc }) => [desc(p.pinnedAt)],
  });
}

export async function deleteProject(db: Database, id: string, actor: Actor) {
  const project = await getProject(db, id);

  await deleteRequirementClaimsForProject(db, id);

  await db.delete(projects).where(eq(projects.id, id));

  await db.insert(activityLog).values({
    entityType: "project",
    entityId: id,
    action: "deleted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { name: project.name },
  });

  return { id };
}

async function deleteRequirementClaimsForProject(db: Database, projectId: string) {
  await db
    .delete(requirementClaims)
    .where(
      sql`${requirementClaims.requirementId} IN (
        SELECT ${requirements.id}
        FROM ${requirements}
        WHERE ${requirements.projectId} = ${projectId}
      )`,
    );
}
