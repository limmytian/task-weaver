import { eq, and, sql, inArray } from "drizzle-orm";
import {
  type Database,
  requirements,
  repositories,
  executionSlices,
  requirementClaims,
  requirementDependencies,
  tasks,
  taskComments,
  activityLog,
  documentRequirementLinks,
  requirementRepositories,
} from "@task-weaver/db";
import type { Actor } from "@task-weaver/contracts";
import type {
  CreateRequirementInput,
  UpdateRequirementInput,
  ListRequirementsInput,
  BatchCreateRequirementsInput,
  CreateExecutionSliceInput,
  UpdateExecutionSliceInput,
} from "@task-weaver/contracts";
import { emit } from "@task-weaver/realtime";
import { assertRequirementLease } from "./claims";
import {
  assertRequirementStatusTransition,
  requirementStatePolicy,
} from "./daemon-state-machine";
import { NotFoundError, ValidationError } from "@task-weaver/contracts";
import { assertExecutionSliceCanAdvance } from "./execution-slice-policy";

export async function createRequirement(
  db: Database,
  input: CreateRequirementInput,
  actor: Actor,
) {
  const [requirement] = await db
    .insert(requirements)
    .values({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      modelTier: input.modelTier,
      tags: input.tags,
      branchName: input.branchName,
      expectedAt: input.expectedAt,
      createdBy: actor.id,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirement!.id,
    action: "created",
    actorId: actor.id,
    actorType: actor.type,
  });

  emit({ type: "requirement_created", projectId: input.projectId, requirementId: requirement!.id, title: input.title });

  return requirement!;
}

export async function getRequirement(db: Database, id: string) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, id),
    with: {
      project: true,
      tasks: { with: { repositories: { with: { repository: true } } } },
      executionSlices: {
        with: { tasks: true },
        orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
      },
      dependencies: { with: { dependsOn: true } },
      dependents: { with: { requirement: true } },
      documentLinks: {
        with: { document: true },
      },
      repositories: { with: { repository: true } },
    },
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return requirement;
}

const TERMINAL_REQ_STATUSES = ["done", "cancelled", "archived"] as const;
const DEFAULT_REQ_COMPLETED_WITHIN_DAYS = 14;

type PagedRequirementList = {
  items: unknown[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  view: "summary" | "full"
}
type RequirementListItem = typeof requirements.$inferSelect & {
  tasks: Array<typeof tasks.$inferSelect>
  dependencies: Array<typeof requirementDependencies.$inferSelect & { dependsOn: typeof requirements.$inferSelect }>
  dependents: Array<typeof requirementDependencies.$inferSelect & { requirement: typeof requirements.$inferSelect }>
  repositories: Array<typeof requirementRepositories.$inferSelect & { repository: typeof repositories.$inferSelect }>
}
type LegacyRequirementList = RequirementListItem[]


export function listRequirements(
  db: Database,
  input: ListRequirementsInput & { view: "summary" | "full" },
): Promise<PagedRequirementList>

export function listRequirements(
  db: Database,
  input: ListRequirementsInput,
): Promise<LegacyRequirementList>

export async function listRequirements(
  db: Database,
  input: ListRequirementsInput,
): Promise<PagedRequirementList | LegacyRequirementList> {
  const conditions = [eq(requirements.projectId, input.projectId)];

  if (input.status) {
    conditions.push(eq(requirements.status, input.status));
  }
  if (input.priority) {
    conditions.push(eq(requirements.priority, input.priority));
  }
  if (input.tag) {
    conditions.push(sql`${input.tag} = ANY(${requirements.tags})`);
  }
  if (input.query) {
    const pattern = `%${input.query}%`;
    conditions.push(sql`(
      ${requirements.title} ILIKE ${pattern}
      OR COALESCE(${requirements.description}, '') ILIKE ${pattern}
    )`);
  }

  const isExplicitTerminalFilter =
    input.status !== undefined &&
    TERMINAL_REQ_STATUSES.includes(input.status as (typeof TERMINAL_REQ_STATUSES)[number]);

  if (!isExplicitTerminalFilter) {
    const days = input.completedWithinDays ?? DEFAULT_REQ_COMPLETED_WITHIN_DAYS;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      conditions.push(
        sql`(${requirements.status} NOT IN ('done', 'cancelled', 'archived') OR ${requirements.updatedAt} >= ${cutoff.toISOString()})`,
      );
    }
  }

  const where = and(...conditions);
  if (input.view === undefined) {
    return db.query.requirements.findMany({
      where,
      with: {
        tasks: {
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        },
        dependencies: { with: { dependsOn: true } },
        dependents: { with: { requirement: true } },
        repositories: { with: { repository: true } },
      },
      orderBy: (r, { desc }) => [desc(r.updatedAt)],
    });
  }

  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? (input.view === "full" ? 5 : 20);
  const offset = (page - 1) * pageSize;
  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(requirements)
    .where(where);

  if (input.view === "summary") {
    const [items, totalRows] = await Promise.all([
      db.query.requirements.findMany({
        where,
        columns: {
          id: true,
          projectId: true,
          title: true,
          status: true,
          priority: true,
          modelTier: true,
          branchName: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: (r, { desc }) => [desc(r.updatedAt)],
        limit: pageSize,
        offset,
      }),
      totalQuery,
    ]);
    const total = totalRows[0]?.count ?? 0;
    return {
      items,
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
      view: "summary" as const,
    };
  }

  const [items, totalRows] = await Promise.all([
    db.query.requirements.findMany({
      where,
      with: {
        tasks: {
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        },
        dependencies: { with: { dependsOn: true } },
        dependents: { with: { requirement: true } },
        repositories: { with: { repository: true } },
      },
      orderBy: (r, { desc }) => [desc(r.updatedAt)],
      limit: pageSize,
      offset,
    }),
    totalQuery,
  ]);
  const total = totalRows[0]?.count ?? 0;
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
    view: "full" as const,
  };
}


export async function updateRequirement(
  db: Database,
  id: string,
  input: UpdateRequirementInput,
  actor: Actor,
) {
  const existing = await getRequirementOrThrow(db, id);
  const { leaseGeneration, daemonId, ...fields } = input;

  if (input.status || leaseGeneration !== undefined || daemonId !== undefined) {
    await assertRequirementLease(db, id, actor, { leaseGeneration, daemonId });
  }

  if (existing.status === "cancelled") {
    throw new ValidationError("Cannot update a cancelled requirement");
  }
  if (input.status) {
    assertRequirementStatusTransition(existing.status, input.status);
  }
  if (input.status === "done") {
    const repositoryLinks = await db
      .select({ deliveryStatus: requirementRepositories.deliveryStatus })
      .from(requirementRepositories)
      .where(eq(requirementRepositories.requirementId, id));
    const incomplete = repositoryLinks.filter(
      (link) => link.deliveryStatus !== "merged" && link.deliveryStatus !== "unchanged",
    );
    if (incomplete.length > 0) {
      throw new ValidationError(
        "Requirement cannot be completed until every repository delivery is merged or unchanged",
      );
    }
  }

  const [updated] = await db
    .update(requirements)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(requirements.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: id,
    action: input.status ? "status_changed" : "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      changes: fields,
      previous: {
        title: existing.title,
        status: existing.status,
        priority: existing.priority,
      },
    },
  });

  if (input.status && requirementStatePolicy(input.status).terminal) {
    await db
      .delete(requirementClaims)
      .where(eq(requirementClaims.requirementId, id));
  }

  emit({ type: "requirement_updated", projectId: updated!.projectId, requirementId: id });

  return updated!;
}

export async function deleteRequirement(
  db: Database,
  id: string,
  actor: Actor,
) {
  const existing = await getRequirementOrThrow(db, id);
  assertRequirementStatusTransition(existing.status, "cancelled");

  const [updated] = await db
    .update(requirements)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(requirements.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: id,
    action: "cancelled",
    actorId: actor.id,
    actorType: actor.type,
  });

  await db
    .delete(requirementClaims)
    .where(eq(requirementClaims.requirementId, id));

  emit({ type: "requirement_deleted", projectId: updated!.projectId, requirementId: id });

  return updated!;
}

export async function batchCreateRequirements(
  db: Database,
  input: BatchCreateRequirementsInput,
  actor: Actor,
) {
  const results = await db.transaction(async (tx) => {
    const created = [];
    for (const reqInput of input.requirements) {
      const [requirement] = await tx
        .insert(requirements)
        .values({
          projectId: reqInput.projectId,
          title: reqInput.title,
          description: reqInput.description,
          status: reqInput.status,
          priority: reqInput.priority,
          modelTier: reqInput.modelTier,
          tags: reqInput.tags,
          branchName: reqInput.branchName,
          createdBy: actor.id,
        })
        .returning();

      await tx.insert(activityLog).values({
        entityType: "requirement",
        entityId: requirement!.id,
        action: "created",
        actorId: actor.id,
        actorType: actor.type,
        metadata: { batch: true },
      });

      created.push(requirement!);
    }
    return created;
  });

  for (const req of results) {
    emit({ type: "requirement_created", projectId: req.projectId, requirementId: req.id, title: req.title });
  }

  return results;
}

export async function linkDocumentToRequirement(
  db: Database,
  requirementId: string,
  documentId: string,
  linkType: "references" | "documents" | "output",
  actor: Actor,
) {
  await getRequirementOrThrow(db, requirementId);

  const [link] = await db
    .insert(documentRequirementLinks)
    .values({ documentId, requirementId, linkType })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "document_linked",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { documentId, linkType },
  });

  return link!;
}

export async function unlinkDocumentFromRequirement(
  db: Database,
  linkId: string,
) {
  const [deleted] = await db
    .delete(documentRequirementLinks)
    .where(eq(documentRequirementLinks.id, linkId))
    .returning();
  if (!deleted) throw new NotFoundError("Document-requirement link not found");
  return deleted;
}

export async function listExecutionSlices(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);
  return db.query.executionSlices.findMany({
    where: eq(executionSlices.requirementId, requirementId),
    with: { tasks: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
  });
}

export async function createExecutionSlice(
  db: Database,
  requirementId: string,
  input: CreateExecutionSliceInput,
  actor: Actor,
) {
  const requirement = await getRequirementOrThrow(db, requirementId);
  const orderIndex = input.orderIndex ?? await nextExecutionSliceOrder(db, requirementId);

  const [slice] = await db
    .insert(executionSlices)
    .values({
      requirementId,
      title: input.title,
      description: input.description,
      orderIndex,
      allowParallel: input.allowParallel,
      modelTier: input.modelTier ?? requirement.modelTier,
    })
    .returning();

  if (input.taskIds) {
    await setTasksForExecutionSlice(db, requirementId, slice!.id, input.taskIds);
  }

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "execution_slice_created",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      sliceId: slice!.id,
      title: input.title,
      orderIndex,
      allowParallel: input.allowParallel,
    },
  });

  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });

  return getExecutionSlice(db, slice!.id);
}

export async function getExecutionSlice(db: Database, sliceId: string) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, sliceId),
    with: { tasks: true, requirement: true },
  });
  if (!slice) throw new NotFoundError("Execution slice not found");
  return slice;
}

export async function updateExecutionSlice(
  db: Database,
  sliceId: string,
  input: UpdateExecutionSliceInput,
  actor: Actor,
) {
  const existing = await getExecutionSlice(db, sliceId);
  const { taskIds, leaseGeneration, daemonId, ...fields } = input;

  if (input.status || leaseGeneration !== undefined || daemonId !== undefined) {
    await assertRequirementLease(
      db,
      existing.requirementId,
      actor,
      { leaseGeneration, daemonId },
    );
  }

  if (input.status && ["in_progress", "in_review", "done"].includes(input.status)) {
    await assertExecutionSliceCanAdvance(db, sliceId, {
      allowParallel: input.allowParallel ?? existing.allowParallel,
    });
  }

  const updateFields: Record<string, unknown> = { ...fields, updatedAt: new Date() };
  if (input.description === null) updateFields.description = null;
  if (input.resultSummary === null) updateFields.resultSummary = null;

  const [updated] = await db
    .update(executionSlices)
    .set(updateFields)
    .where(eq(executionSlices.id, sliceId))
    .returning();

  if (taskIds) {
    await setTasksForExecutionSlice(db, existing.requirementId, sliceId, taskIds);
  }

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: existing.requirementId,
    action: "execution_slice_updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { sliceId, changes: fields },
  });

  emit({ type: "requirement_updated", projectId: existing.requirement.projectId, requirementId: existing.requirementId });

  return getExecutionSlice(db, updated!.id);
}

export async function deleteExecutionSlice(db: Database, sliceId: string, actor: Actor) {
  const existing = await getExecutionSlice(db, sliceId);

  await db
    .update(tasks)
    .set({ executionSliceId: null, updatedAt: new Date() })
    .where(eq(tasks.executionSliceId, sliceId));

  const [deleted] = await db
    .delete(executionSlices)
    .where(eq(executionSlices.id, sliceId))
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: existing.requirementId,
    action: "execution_slice_deleted",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { sliceId, title: existing.title },
  });

  emit({ type: "requirement_updated", projectId: existing.requirement.projectId, requirementId: existing.requirementId });

  return deleted!;
}

async function nextExecutionSliceOrder(db: Database, requirementId: string) {
  const rows = await db
    .select({ maxOrder: sql<number>`COALESCE(MAX(${executionSlices.orderIndex}), -1)` })
    .from(executionSlices)
    .where(eq(executionSlices.requirementId, requirementId));
  return Number(rows[0]?.maxOrder ?? -1) + 1;
}

async function setTasksForExecutionSlice(
  db: Database,
  requirementId: string,
  sliceId: string,
  taskIds: string[],
) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, sliceId),
  });
  if (!slice) throw new NotFoundError("Execution slice not found");
  if (slice.requirementId !== requirementId) {
    throw new ValidationError("Execution slice must belong to the requirement");
  }

  if (taskIds.length > 0) {
    const taskRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
    });
    if (taskRows.length !== taskIds.length) {
      throw new NotFoundError("One or more tasks were not found");
    }
    if (taskRows.some((task) => task.requirementId !== requirementId)) {
      throw new ValidationError("All slice tasks must belong to the same requirement");
    }
  }

  await db
    .update(tasks)
    .set({ executionSliceId: null, updatedAt: new Date() })
    .where(eq(tasks.executionSliceId, sliceId));

  if (taskIds.length === 0) return;

  await db
    .update(tasks)
    .set({ executionSliceId: sliceId, updatedAt: new Date() })
    .where(inArray(tasks.id, taskIds));
}

export async function addRequirementDependency(
  db: Database,
  requirementId: string,
  dependsOnRequirementId: string,
  type: "blocks" | "related",
  actor: Actor,
  description?: string,
) {
  const [requirement, dependsOn] = await Promise.all([
    getRequirementOrThrow(db, requirementId),
    getRequirementOrThrow(db, dependsOnRequirementId),
  ]);

  if (requirementId === dependsOnRequirementId) {
    throw new ValidationError("A requirement cannot depend on itself");
  }

  if (requirement.projectId !== dependsOn.projectId) {
    throw new ValidationError("Requirement dependencies must stay within the same project");
  }

  const existingDeps = await db.query.requirementDependencies.findMany({
    where: eq(requirementDependencies.requirementId, requirementId),
  });
  if (
    existingDeps.some(
      (dep) =>
        dep.dependsOnRequirementId === dependsOnRequirementId &&
        dep.type === type,
    )
  ) {
    throw new ValidationError("Requirement dependency already exists");
  }

  if (await wouldCreateRequirementDependencyCycle(db, requirementId, dependsOnRequirementId)) {
    throw new ValidationError("Requirement dependency would create a cycle");
  }

  const [dep] = await db
    .insert(requirementDependencies)
    .values({ requirementId, dependsOnRequirementId, type, description })
    .returning();

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "dependency_added",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { dependsOnRequirementId, type, description },
  });

  emit({ type: "requirement_updated", projectId: requirement.projectId, requirementId });

  return dep!;
}

export async function listRequirementDependencies(db: Database, requirementId: string) {
  await getRequirementOrThrow(db, requirementId);

  const [dependencies, dependents] = await Promise.all([
    db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.requirementId, requirementId),
      with: { dependsOn: true },
    }),
    db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.dependsOnRequirementId, requirementId),
      with: { requirement: true },
    }),
  ]);

  return { dependencies, dependents };
}

export async function removeRequirementDependency(
  db: Database,
  depId: string,
  actor?: Actor,
) {
  const [deleted] = await db
    .delete(requirementDependencies)
    .where(eq(requirementDependencies.id, depId))
    .returning();

  if (!deleted) throw new NotFoundError("Requirement dependency not found");

  if (actor) {
    await db.insert(activityLog).values({
      entityType: "requirement",
      entityId: deleted.requirementId,
      action: "dependency_removed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: {
        dependsOnRequirementId: deleted.dependsOnRequirementId,
        type: deleted.type,
      },
    });
  }

  return deleted;
}

export async function checkBlockingRequirementDependencies(
  db: Database,
  requirementId: string,
) {
  const deps = await db.query.requirementDependencies.findMany({
    where: eq(requirementDependencies.requirementId, requirementId),
    with: { dependsOn: true },
  });

  return deps
    .filter((dep: any) =>
      dep.type === "blocks" &&
      dep.dependsOn &&
      dep.dependsOn.status !== "done" &&
      dep.dependsOn.status !== "cancelled"
    )
    .map((dep: any) => ({
      dependencyId: dep.id,
      requirementId: dep.dependsOnRequirementId,
      title: dep.dependsOn.title,
      status: dep.dependsOn.status,
    }));
}

async function wouldCreateRequirementDependencyCycle(
  db: Database,
  requirementId: string,
  dependsOnRequirementId: string,
) {
  const visited = new Set<string>();
  const stack = [dependsOnRequirementId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === requirementId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = await db.query.requirementDependencies.findMany({
      where: eq(requirementDependencies.requirementId, current),
    });

    for (const dep of deps) {
      stack.push(dep.dependsOnRequirementId);
    }
  }

  return false;
}

export interface SearchRequirementsInput {
  query: string;
  projectId?: string;
  limit?: number;
}

export async function searchRequirements(
  db: Database,
  input: SearchRequirementsInput,
) {
  const likePattern = `%${input.query}%`;
  const conditions = [
    sql`(${requirements.title} ILIKE ${likePattern} OR ${requirements.description} ILIKE ${likePattern} OR EXISTS (SELECT 1 FROM unnest(${requirements.tags}) AS t WHERE t ILIKE ${likePattern}))`,
  ];
  if (input.projectId) {
    conditions.push(sql`${requirements.projectId} = ${input.projectId}`);
  }

  return db
    .select({
      id: requirements.id,
      title: requirements.title,
      description: requirements.description,
      status: requirements.status,
      priority: requirements.priority,
      projectId: requirements.projectId,
      tags: requirements.tags,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(...conditions))
    .limit(input.limit ?? 20);
}

export interface BurndownDataPoint {
  date: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
}

export interface RequirementBurndown {
  requirementId: string;
  title: string;
  totalTasks: number;
  completedTasks: number;
  startDate: string;
  endDate: string;
  dataPoints: BurndownDataPoint[];
  idealLine: { date: string; remaining: number }[];
  velocity: number;
  projectedCompletionDate: string | null;
}

export async function getRequirementBurndown(
  db: Database,
  requirementId: string,
): Promise<RequirementBurndown> {
  const requirement = await getRequirementOrThrow(db, requirementId);

  const taskList = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      createdAt: tasks.createdAt,
      completedAt: tasks.completedAt,
    })
    .from(tasks)
    .where(eq(tasks.requirementId, requirementId));

  if (taskList.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      requirementId,
      title: requirement.title,
      totalTasks: 0,
      completedTasks: 0,
      startDate: today,
      endDate: today,
      dataPoints: [],
      idealLine: [],
      velocity: 0,
      projectedCompletionDate: null,
    };
  }

  // Determine date range (use date strings to avoid timezone issues)
  const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const createdDates = taskList.map((t) => t.createdAt);
  const startDate = new Date(Math.min(...createdDates.map((d) => d.getTime())));
  const now = new Date();
  const endDateStr = toDateStr(now);

  // Build daily data points
  const dataPoints: BurndownDataPoint[] = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);

  while (toDateStr(cursor) <= endDateStr) {
    const dateStr = toDateStr(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(23, 59, 59, 999);

    // Tasks that existed by this date
    const existingTasks = taskList.filter((t) => t.createdAt <= dayEnd);
    // Tasks completed by this date
    const completed = existingTasks.filter(
      (t) => t.completedAt && t.completedAt <= dayEnd,
    );

    dataPoints.push({
      date: dateStr,
      totalTasks: existingTasks.length,
      completedTasks: completed.length,
      remainingTasks: existingTasks.length - completed.length,
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  // Build ideal line (linear from total tasks to 0)
  const totalTasks = taskList.length;
  const completedTasks = taskList.filter(
    (t) => t.status === "done" || t.status === "cancelled",
  ).length;

  const idealLine: { date: string; remaining: number }[] = [];
  if (dataPoints.length > 1) {
    const totalDays = dataPoints.length - 1;
    for (let i = 0; i <= totalDays; i++) {
      idealLine.push({
        date: dataPoints[i]!.date,
        remaining: Math.round(totalTasks * (1 - i / totalDays)),
      });
    }
  } else if (dataPoints.length === 1) {
    idealLine.push({ date: dataPoints[0]!.date, remaining: totalTasks });
  }

  // Calculate velocity (tasks completed per day over the last 7 days)
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCompletions = taskList.filter(
    (t) => t.completedAt && t.completedAt >= sevenDaysAgo && t.completedAt <= now,
  ).length;
  const daysSinceStart = Math.max(1, dataPoints.length);
  const effectiveDays = Math.min(7, daysSinceStart);
  const velocity = recentCompletions / effectiveDays;

  // Project completion date
  const remaining = totalTasks - completedTasks;
  let projectedCompletionDate: string | null = null;
  if (remaining > 0 && velocity > 0) {
    const daysToComplete = Math.ceil(remaining / velocity);
    const projected = new Date(now);
    projected.setDate(projected.getDate() + daysToComplete);
    projectedCompletionDate = toDateStr(projected);
  } else if (remaining === 0) {
    projectedCompletionDate = endDateStr;
  }

  return {
    requirementId,
    title: requirement.title,
    totalTasks,
    completedTasks,
    startDate: toDateStr(startDate),
    endDate: endDateStr,
    dataPoints,
    idealLine,
    velocity: Math.round(velocity * 100) / 100,
    projectedCompletionDate,
  };
}

export interface RequirementHeatmapItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  commentCount: number;
  documentLinkCount: number;
  activityCount: number;
  lastActivityAt: string | null;
  daysSinceLastActivity: number | null;
  heatScore: number;
}

export interface RequirementHeatmap {
  projectId: string;
  generatedAt: string;
  requirements: RequirementHeatmapItem[];
  hotspots: RequirementHeatmapItem[];
  coldspots: RequirementHeatmapItem[];
}

export async function getRequirementHeatmap(
  db: Database,
  projectId: string,
): Promise<RequirementHeatmap> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Get all non-cancelled requirements for the project
  const reqList = await db
    .select({
      id: requirements.id,
      title: requirements.title,
      status: requirements.status,
      priority: requirements.priority,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), sql`${requirements.status} != 'cancelled'`));

  if (reqList.length === 0) {
    return {
      projectId,
      generatedAt: now.toISOString(),
      requirements: [],
      hotspots: [],
      coldspots: [],
    };
  }

  const reqIds = reqList.map((r) => r.id);

  // Task stats per requirement
  const taskStats = await db
    .select({
      requirementId: tasks.requirementId,
      totalTasks: sql<number>`count(*)::int`,
      completedTasks: sql<number>`count(CASE WHEN ${tasks.status} = 'done' THEN 1 END)::int`,
      overdueTasks: sql<number>`count(CASE WHEN ${tasks.expectedAt} < now() AND ${tasks.status} NOT IN ('done', 'cancelled') THEN 1 END)::int`,
    })
    .from(tasks)
    .where(inArray(tasks.requirementId, reqIds))
    .groupBy(tasks.requirementId);

  const taskStatsMap = new Map(taskStats.map((r) => [r.requirementId, r]));

  // Comment counts per requirement (via tasks)
  const commentStats = await db
    .select({
      requirementId: tasks.requirementId,
      commentCount: sql<number>`count(${taskComments.id})::int`,
    })
    .from(taskComments)
    .innerJoin(tasks, eq(taskComments.taskId, tasks.id))
    .where(inArray(tasks.requirementId, reqIds))
    .groupBy(tasks.requirementId);

  const commentMap = new Map(commentStats.map((r) => [r.requirementId, r.commentCount]));

  // Document link counts per requirement
  const docLinkStats = await db
    .select({
      requirementId: documentRequirementLinks.requirementId,
      linkCount: sql<number>`count(*)::int`,
    })
    .from(documentRequirementLinks)
    .where(inArray(documentRequirementLinks.requirementId, reqIds))
    .groupBy(documentRequirementLinks.requirementId);

  const docLinkMap = new Map(docLinkStats.map((r) => [r.requirementId, r.linkCount]));

  // Activity counts (last 30 days) per requirement — includes task activities under each requirement
  const reqIdList = sql.join(reqIds.map((id) => sql`${id}`), sql`, `);
  const reqIdArray = sql`ARRAY[${reqIdList}]::uuid[]`;
  const activityStats = await db
    .select({
      requirementId: sql<string>`coalesce(t.requirement_id, ${activityLog.entityId})`,
      activityCount: sql<number>`count(*)::int`,
      lastActivityAt: sql<string>`max(${activityLog.createdAt})`,
    })
    .from(activityLog)
    .leftJoin(sql`tasks t`, sql`${activityLog.entityType} = 'task' AND ${activityLog.entityId} = t.id`)
    .where(
      and(
        sql`${activityLog.createdAt} >= ${thirtyDaysAgo.toISOString()}`,
        sql`(
          (${activityLog.entityType} = 'requirement' AND ${activityLog.entityId} = ANY(${reqIdArray}))
          OR
          (${activityLog.entityType} = 'task' AND t.requirement_id = ANY(${reqIdArray}))
        )`,
      ),
    )
    .groupBy(sql`coalesce(t.requirement_id, ${activityLog.entityId})`);

  const activityMap = new Map(
    activityStats.map((r) => [r.requirementId, { count: r.activityCount, lastAt: r.lastActivityAt }]),
  );

  // Build heatmap items
  const items: RequirementHeatmapItem[] = reqList.map((req) => {
    const ts = taskStatsMap.get(req.id);
    const totalTasks = ts?.totalTasks ?? 0;
    const completedTasks = ts?.completedTasks ?? 0;
    const overdueTasks = ts?.overdueTasks ?? 0;
    const commentCount = commentMap.get(req.id) ?? 0;
    const documentLinkCount = docLinkMap.get(req.id) ?? 0;
    const activity = activityMap.get(req.id);
    const activityCount = activity?.count ?? 0;
    const lastActivityAt = activity?.lastAt ?? null;

    const daysSinceLastActivity = lastActivityAt
      ? Math.floor((now.getTime() - new Date(lastActivityAt).getTime()) / 86400000)
      : null;

    // Heat score: higher = more active / more attention needed
    // Factors: activity count, overdue tasks, comment engagement
    const activityHeat = Math.min(activityCount / 10, 1) * 40;
    const overdueHeat = totalTasks > 0 ? (overdueTasks / totalTasks) * 30 : 0;
    const engagementHeat = Math.min((commentCount + documentLinkCount) / 10, 1) * 20;
    const recencyHeat = daysSinceLastActivity !== null
      ? Math.max(0, 1 - daysSinceLastActivity / 30) * 10
      : 0;

    const heatScore = Math.round(activityHeat + overdueHeat + engagementHeat + recencyHeat);

    return {
      id: req.id,
      title: req.title,
      status: req.status,
      priority: req.priority,
      totalTasks,
      completedTasks,
      overdueTasks,
      commentCount,
      documentLinkCount,
      activityCount,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
      daysSinceLastActivity,
      heatScore,
    };
  });

  // Sort by heat score descending
  items.sort((a, b) => b.heatScore - a.heatScore);

  // Top 5 hotspots, bottom 5 coldspots (active requirements only)
  const activeItems = items.filter((i) => i.status !== "done");
  const hotspots = activeItems.slice(0, 5);
  const coldspots = activeItems.filter((i) => i.totalTasks > 0).slice(-5).reverse();

  return {
    projectId,
    generatedAt: now.toISOString(),
    requirements: items,
    hotspots,
    coldspots,
  };
}

async function getRequirementOrThrow(db: Database, id: string) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, id),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  return requirement;
}
