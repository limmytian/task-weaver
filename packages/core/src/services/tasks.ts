import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Database,
  tasks,
  taskStatusLog,
  taskComments,
  taskNotes,
  taskDependencies,
  taskClaims,
  activityLog,
  executionSlices,
  taskRepositories,
  requirementRepositories,
  requirements,
  repositories,
} from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import type { Actor } from "@task-weaver/contracts";
import type {
  CreateTaskInput,
  UpdateTaskInput,
  ListTasksInput,
  TaskStatus,
  BatchCreateTasksInput,
  BatchUpdateTasksInput,
  CreatePersonalTaskInput,
} from "@task-weaver/contracts";
import { NotFoundError, ValidationError, ConflictError } from "@task-weaver/contracts";
import { checkBlockingDependencies } from "./claims";
import { assertRequirementLease } from "./claims";
import type { RequirementLeaseFence } from "@task-weaver/contracts";
import { requirementStatusAfterTaskCreation } from "./daemon-state-machine";
import { updateRequirement } from "./requirements";
import { recordTaskStatusProgress } from "./daemon-progress";
import { assertExecutionSliceCanAdvance } from "./execution-slice-policy";

async function routeRequirementForCreatedTask(
  db: Database,
  requirementId: string,
  taskStatus: TaskStatus,
  actor: Actor,
  fence: RequirementLeaseFence,
) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");
  const nextStatus = requirementStatusAfterTaskCreation(requirement.status, taskStatus);
  if (nextStatus === requirement.status) return;
  await updateRequirement(db, requirementId, {
    status: nextStatus,
    daemonId: fence.daemonId,
    leaseGeneration: fence.leaseGeneration,
  }, actor);
}

export async function createTask(
  db: Database,
  input: CreateTaskInput,
  actor: Actor,
) {
  const taskScope = input.scope ?? "project";
  const expectedAt = input.expectedAt ?? new Date(Date.now() + 7 * 86_400_000);
  if (taskScope === "project" && (!input.projectId || !input.requirementId)) {
    throw new ValidationError("Project tasks require projectId and requirementId");
  }
  if (taskScope === "personal" && (input.projectId || input.requirementId || input.executionSliceId)) {
    throw new ValidationError("Personal tasks cannot belong to a project, requirement, or execution slice");
  }
  if (taskScope === "project" && input.executionSliceId && input.requirementId) {
    await validateTaskSlice(db, input.requirementId, input.executionSliceId);
  }

  const task = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    if (taskScope === "project" && input.requirementId) {
      await routeRequirementForCreatedTask(
        txDb,
        input.requirementId,
        input.status ?? "todo",
        actor,
        { daemonId: input.daemonId, leaseGeneration: input.leaseGeneration },
      );
    }

    const [created] = await tx
      .insert(tasks)
      .values({
        scope: taskScope,
        projectId: input.projectId,
        requirementId: input.requirementId,
        executionSliceId: input.executionSliceId,
        personalOwnerId: taskScope === "personal" ? (input.personalOwnerId ?? actor.id) : null,
        personalOwnerType: taskScope === "personal" ? (input.personalOwnerType ?? actor.type) : null,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assignee: input.assignee,
        assigneeType: input.assigneeType,
        requestedProvider: input.requestedProvider,
        requestedModel: input.requestedModel,
        tags: input.tags,
        branchName: input.branchName,
        expectedAt,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(taskStatusLog).values({
      taskId: created!.id,
      fromStatus: null,
      toStatus: input.status ?? "todo",
      changedBy: actor.id,
      changedByType: actor.type,
    });

    await tx.insert(activityLog).values({
      entityType: "task",
      entityId: created!.id,
      action: "created",
      actorId: actor.id,
      actorType: actor.type,
      metadata: { title: input.title, status: input.status ?? "todo" },
    });
    return created!;
  });

  emit({ type: "task_created", projectId: input.projectId ?? null, taskId: task!.id, title: input.title });

  return task;
}

export async function createPersonalTask(
  db: Database,
  input: CreatePersonalTaskInput,
  actor: Actor,
) {
  return createTask(db, {
    ...input,
    scope: "personal",
    personalOwnerId: input.personalOwnerId ?? actor.id,
    personalOwnerType: input.personalOwnerType ?? actor.type,
  }, actor);
}

export async function getTask(db: Database, id: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
  });
  if (!task) throw new NotFoundError("Task not found");
  return task;
}

export async function getTaskDetail(db: Database, id: string) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    with: {
      requirement: true,
      comments: { orderBy: (c, { desc }) => [desc(c.createdAt)] },
      notes: { orderBy: (n, { desc }) => [desc(n.createdAt)] },
      dependencies: { with: { dependsOn: true } },
      dependents: { with: { task: true } },
      documentLinks: { with: { document: true } },
      statusLogs: { orderBy: (l, { desc }) => [desc(l.createdAt)] },
      repositories: { with: { repository: true } },
    },
  });
  if (!task) throw new NotFoundError("Task not found");
  return task;
}

const TERMINAL_TASK_STATUSES = ["done", "cancelled"] as const;
const DEFAULT_COMPLETED_WITHIN_DAYS = 14;

type PagedTaskList = {
  items: unknown[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  view: "summary" | "full"
}

type TaskListItem = typeof tasks.$inferSelect & {
  repositories: Array<typeof taskRepositories.$inferSelect & { repository: typeof repositories.$inferSelect }>
}

export function listTasks(
  db: Database,
  input: ListTasksInput & { view: "summary" | "full" },
  authorizedPredicate?: SQL,
): Promise<PagedTaskList>

export function listTasks(
  db: Database,
  input: ListTasksInput,
  authorizedPredicate?: SQL,
): Promise<Array<TaskListItem>>

export async function listTasks(
  db: Database,
  input: ListTasksInput,
  authorizedPredicate?: SQL,
): Promise<PagedTaskList | Array<TaskListItem>> {
  const taskScope = input.scope ?? "project";
  const conditions = [eq(tasks.scope, taskScope), authorizedPredicate];

  if (taskScope === "project") {
    if (!input.projectId) throw new ValidationError("Project task listing requires projectId");
    conditions.push(eq(tasks.projectId, input.projectId));
  } else {
    conditions.push(isNull(tasks.projectId), isNull(tasks.requirementId));
    if (input.personalOwnerId) {
      conditions.push(eq(tasks.personalOwnerId, input.personalOwnerId));
    }
    if (input.personalOwnerType) {
      conditions.push(eq(tasks.personalOwnerType, input.personalOwnerType));
    }
  }

  if (input.status) {
    conditions.push(eq(tasks.status, input.status));
  }
  if (input.assignee) {
    conditions.push(eq(tasks.assignee, input.assignee));
  }
  if (input.priority) {
    conditions.push(eq(tasks.priority, input.priority));
  }
  if (input.tag) {
    conditions.push(sql`${input.tag} = ANY(${tasks.tags})`);
  }
  if (input.requirementId) {
    if (taskScope !== "project") {
      throw new ValidationError("Only project tasks can be filtered by requirementId");
    }
    conditions.push(eq(tasks.requirementId, input.requirementId));
  }
  if (input.query) {
    const pattern = `%${input.query}%`;
    conditions.push(sql`(
      ${tasks.title} ILIKE ${pattern}
      OR COALESCE(${tasks.description}, '') ILIKE ${pattern}
    )`);
  }

  const isExplicitTerminalFilter =
    input.status !== undefined &&
    TERMINAL_TASK_STATUSES.includes(input.status as (typeof TERMINAL_TASK_STATUSES)[number]);

  if (!isExplicitTerminalFilter) {
    const days = input.completedWithinDays ?? DEFAULT_COMPLETED_WITHIN_DAYS;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      conditions.push(
        sql`(${tasks.status} NOT IN ('done', 'cancelled') OR COALESCE(${tasks.completedAt}, ${tasks.updatedAt}) >= ${cutoff.toISOString()})`,
      );
    }
  }

  const where = and(...conditions);
  if (input.view === undefined) {
    return db.query.tasks.findMany({
      where,
      with: { repositories: { with: { repository: true } } },
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
  }

  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? (input.view === "full" ? 5 : 20);
  const offset = (page - 1) * pageSize;
  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(where);

  if (input.view === "summary") {
    const [items, totalRows] = await Promise.all([
      db.query.tasks.findMany({
        where,
        columns: {
          id: true,
          scope: true,
          projectId: true,
          requirementId: true,
          executionSliceId: true,
          title: true,
          status: true,
          priority: true,
          assignee: true,
          assigneeType: true,
          branchName: true,
          expectedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: (t, { desc }) => [desc(t.updatedAt)],
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
    db.query.tasks.findMany({
      where,
      with: { repositories: { with: { repository: true } } },
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
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

export async function getRequirementTaskDependencyGraph(
  db: Database,
  requirementId: string,
  authorizedPredicate?: SQL,
) {
  const taskRows = await db.query.tasks.findMany({
    where: and(eq(tasks.requirementId, requirementId), authorizedPredicate),
    with: {
      dependencies: { with: { dependsOn: true } },
    },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  const dependencyIds = taskRows.flatMap(task => task.dependencies.map(dep => dep.dependsOnTaskId));
  const allowedDependencies = dependencyIds.length ? await db.select({ id: tasks.id }).from(tasks)
    .where(and(inArray(tasks.id, dependencyIds), authorizedPredicate)) : [];
  const allowedIds = new Set(allowedDependencies.map(row => row.id));
  const nodeIds = new Set(taskRows.map((task) => task.id));
  const externalNodes = new Map<string, {
    id: string;
    title: string;
    status: string;
    priority: string;
    requirementId: string;
    external: true;
  }>();

  const edges: Array<{
    id: string;
    source: string;
    target: string;
    type: "blocks" | "related";
    description: string | null;
  }> = [];

  for (const task of taskRows) {
    for (const dep of task.dependencies ?? []) {
      if (!dep.dependsOn || !allowedIds.has(dep.dependsOnTaskId)) continue;

      if (!nodeIds.has(dep.dependsOnTaskId)) {
        externalNodes.set(dep.dependsOnTaskId, {
          id: dep.dependsOn.id,
          title: dep.dependsOn.title,
          status: dep.dependsOn.status,
          priority: dep.dependsOn.priority,
          requirementId: dep.dependsOn.requirementId!,
          external: true,
        });
      }

      edges.push({
        id: dep.id,
        source: dep.dependsOnTaskId,
        target: dep.taskId,
        type: dep.type,
        description: dep.description,
      });
    }
  }

  return {
    requirementId,
    nodes: [
      ...taskRows.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        requirementId: task.requirementId!,
        external: false,
      })),
      ...externalNodes.values(),
    ],
    edges,
  };
}

export async function updateTask(
  db: Database,
  id: string,
  input: UpdateTaskInput,
  actor: Actor,
) {
  const task = await getTask(db, id);

  const { expectedVersion, ...fields } = input;
  if (task.scope === "personal" && (fields.requirementId || fields.executionSliceId)) {
    throw new ValidationError("Personal tasks cannot be moved into a requirement or execution slice");
  }
  if (fields.executionSliceId) {
    const targetRequirementId = fields.requirementId ?? task.requirementId;
    if (!targetRequirementId) {
      throw new ValidationError("Execution slices require a project requirement");
    }
    await validateTaskSlice(db, targetRequirementId, fields.executionSliceId);
  }
  if (fields.requirementId && fields.requirementId !== task.requirementId) {
    const linkedRepositories = await db
      .select({ repositoryId: taskRepositories.repositoryId })
      .from(taskRepositories)
      .where(eq(taskRepositories.taskId, id));
    if (linkedRepositories.length > 0) {
      const targetLinks = await db
        .select({ repositoryId: requirementRepositories.repositoryId })
        .from(requirementRepositories)
        .where(eq(requirementRepositories.requirementId, fields.requirementId));
      const targetIds = new Set(targetLinks.map((link) => link.repositoryId));
      const invalid = linkedRepositories
        .map((link) => link.repositoryId)
        .filter((repositoryId) => !targetIds.has(repositoryId));
      if (invalid.length > 0) {
        throw new ValidationError(
          `Cannot move task: repositories are not linked to the target requirement: ${invalid.join(", ")}`,
        );
      }
    }
  }

  if (expectedVersion !== undefined && task.version !== expectedVersion) {
    throw new ConflictError(
      `Version conflict: expected ${expectedVersion}, but current is ${task.version}. ` +
      `Re-read the task and retry with the latest version.`,
      task.version,
    );
  }

  const [updated] = await db
    .update(tasks)
    .set({ ...fields, version: task.version + 1, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: id,
    action: "updated",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { changes: fields },
  });

  emit({ type: "task_updated", projectId: updated!.projectId, taskId: id });

  return updated!;
}

async function validateTaskSlice(db: Database, requirementId: string, executionSliceId: string) {
  const slice = await db.query.executionSlices.findFirst({
    where: eq(executionSlices.id, executionSliceId),
  });
  if (!slice) throw new NotFoundError("Execution slice not found");
  if (slice.requirementId !== requirementId) {
    throw new ValidationError("Task execution slice must belong to the same requirement");
  }
}

export async function updateTaskStatus(
  db: Database,
  id: string,
  newStatus: TaskStatus,
  actor: Actor,
  reason?: string,
  force?: boolean,
  leaseFence?: RequirementLeaseFence,
) {
  const task = await getTask(db, id);
  let activeRequirementClaim: Awaited<ReturnType<typeof assertRequirementLease>> = null;

  if (task.requirementId) {
    activeRequirementClaim = await assertRequirementLease(db, task.requirementId, actor, leaseFence);
  }

  if (task.status === "cancelled") {
    throw new ValidationError(
      "Cannot change status of a cancelled task. Create a new task instead.",
    );
  }

  if (
    task.executionSliceId
    && (newStatus === "in_progress" || newStatus === "in_review" || newStatus === "done")
  ) {
    await assertExecutionSliceCanAdvance(db, task.executionSliceId);
  }

  // Dependency enforcement: block advancement when upstream tasks are incomplete
  if (!force && (newStatus === "in_progress" || newStatus === "in_review" || newStatus === "done")) {
    const blockers = await checkBlockingDependencies(db, id);
    if (blockers.length > 0) {
      const blockerList = blockers.map(b => `"${b.title}" (${b.status})`).join(", ");
      throw new ValidationError(
        `Cannot move to '${newStatus}': blocked by unfinished dependencies: ${blockerList}. ` +
        `Complete them first, or use force=true to override.`,
      );
    }
  }

  const now = new Date();

  const [updated] = await db
    .update(tasks)
    .set({
      status: newStatus,
      completedAt: newStatus === "done" ? now : null,
      version: task.version + 1,
      updatedAt: now,
    })
    .where(eq(tasks.id, id))
    .returning();

  await db.insert(taskStatusLog).values({
    taskId: id,
    fromStatus: task.status,
    toStatus: newStatus,
    changedBy: actor.id,
    changedByType: actor.type,
    reason,
  });

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: id,
    action: "status_changed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { from: task.status, to: newStatus, reason },
  });

  // Auto-release claim when task reaches terminal status
  if (newStatus === "done" || newStatus === "cancelled") {
    await db
      .delete(taskClaims)
      .where(eq(taskClaims.taskId, id));
  }

  if (
    task.requirementId
    && activeRequirementClaim?.daemonId
    && leaseFence?.daemonId === activeRequirementClaim.daemonId
  ) {
    await recordTaskStatusProgress(db, {
      daemonId: activeRequirementClaim.daemonId,
      runId: activeRequirementClaim.id,
      workerIndex: Number(activeRequirementClaim.workerIndex ?? 0),
      leaseGeneration: activeRequirementClaim.generation,
      projectId: task.projectId,
      requirementId: task.requirementId,
      executionSliceId: task.executionSliceId ?? null,
      taskId: task.id,
      taskStatus: newStatus,
      previousTaskStatus: task.status,
      taskTitle: task.title,
      reason,
      actor,
    });
  }

  emit({ type: "task_status_changed", projectId: task.projectId, taskId: id, from: task.status, to: newStatus });

  return updated!;
}

export async function addTaskComment(
  db: Database,
  taskId: string,
  content: string,
  actor: Actor,
) {
  await getTask(db, taskId);

  const [comment] = await db
    .insert(taskComments)
    .values({
      taskId,
      content,
      authorId: actor.id,
      authorType: actor.type,
    })
    .returning();

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: taskId,
    action: "commented",
    actorId: actor.id,
    actorType: actor.type,
  });

  const taskForEvent = await getTask(db, taskId);
  emit({ type: "task_commented", projectId: taskForEvent.projectId, taskId });

  return comment!;
}

export async function addTaskNote(
  db: Database,
  taskId: string,
  content: string,
  pinned: boolean,
  actor: Actor,
) {
  await getTask(db, taskId);

  const [note] = await db
    .insert(taskNotes)
    .values({
      taskId,
      content,
      pinned,
      authorId: actor.id,
      authorType: actor.type,
    })
    .returning();

  return note!;
}

export async function addTaskDependency(
  db: Database,
  taskId: string,
  dependsOnTaskId: string,
  type: "blocks" | "related",
  actor: Actor,
  description?: string,
) {
  await getTask(db, taskId);
  await getTask(db, dependsOnTaskId);

  if (taskId === dependsOnTaskId) {
    throw new ValidationError("A task cannot depend on itself");
  }

  const [dep] = await db
    .insert(taskDependencies)
    .values({ taskId, dependsOnTaskId, type, description })
    .returning();

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: taskId,
    action: "dependency_added",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { dependsOnTaskId, type, description },
  });

  return dep!;
}

export interface SearchTasksInput {
  query: string;
  projectId?: string;
  scope?: "project" | "personal";
  personalOwnerId?: string;
  personalOwnerType?: "human" | "agent";
  limit?: number;
}

export async function searchTasks(db: Database, input: SearchTasksInput, authorizedPredicate?: SQL) {
  const likePattern = `%${input.query}%`;
  const taskScope = input.scope ?? "project";
  const conditions = [
    eq(tasks.scope, taskScope),
    sql`(${tasks.title} ILIKE ${likePattern} OR ${tasks.description} ILIKE ${likePattern} OR EXISTS (SELECT 1 FROM unnest(${tasks.tags}) AS t WHERE t ILIKE ${likePattern}))`,
  ];
  if (taskScope === "project" && input.projectId) {
    conditions.push(sql`${tasks.projectId} = ${input.projectId}`);
  } else if (taskScope === "personal") {
    conditions.push(isNull(tasks.projectId), isNull(tasks.requirementId));
    if (input.personalOwnerId) conditions.push(eq(tasks.personalOwnerId, input.personalOwnerId));
    if (input.personalOwnerType) conditions.push(eq(tasks.personalOwnerType, input.personalOwnerType));
  }

  const matched = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      projectId: tasks.projectId,
      scope: tasks.scope,
      personalOwnerId: tasks.personalOwnerId,
      personalOwnerType: tasks.personalOwnerType,
      tags: tasks.tags,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(...conditions, authorizedPredicate))
    .limit(input.limit ?? 20);

  if (matched.length === 0) return matched.map((task) => ({ ...task, repositories: [] }));
  const repositoryLinks = await db.query.taskRepositories.findMany({
    where: inArray(taskRepositories.taskId, matched.map((task) => task.id)),
    with: { repository: true },
  });
  const byTask = new Map<string, typeof repositoryLinks>();
  for (const link of repositoryLinks) {
    byTask.set(link.taskId, [...(byTask.get(link.taskId) ?? []), link]);
  }
  return matched.map((task) => ({ ...task, repositories: byTask.get(task.id) ?? [] }));
}

export async function deleteTask(
  db: Database,
  id: string,
  actor: Actor,
) {
  const task = await getTask(db, id);

  if (task.status === "cancelled") {
    throw new ValidationError("Task is already cancelled");
  }

  const [updated] = await db
    .update(tasks)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();

  await db.insert(taskStatusLog).values({
    taskId: id,
    fromStatus: task.status,
    toStatus: "cancelled",
    changedBy: actor.id,
    changedByType: actor.type,
    reason: "Task cancelled",
  });

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: id,
    action: "cancelled",
    actorId: actor.id,
    actorType: actor.type,
  });

  emit({ type: "task_deleted", projectId: task.projectId, taskId: id });

  return updated!;
}

export async function removeTaskDependency(db: Database, depId: string, _expectedParentId?: string) {
  const [deleted] = await db
    .delete(taskDependencies)
    .where(eq(taskDependencies.id, depId))
    .returning();
  if (!deleted) throw new NotFoundError("Dependency not found");
  return deleted;
}

export async function batchCreateTasks(
  db: Database,
  input: BatchCreateTasksInput,
  actor: Actor,
) {
  const results = await db.transaction(async (tx) => {
    const created = [];
    for (const taskInput of input.tasks) {
      const batchExpectedAt = taskInput.expectedAt ?? new Date(Date.now() + 7 * 86_400_000);
      const taskScope = taskInput.scope ?? "project";
      if (taskScope === "project" && (!taskInput.projectId || !taskInput.requirementId)) {
        throw new ValidationError("Project tasks require projectId and requirementId");
      }
      if (taskScope === "personal" && (taskInput.projectId || taskInput.requirementId || taskInput.executionSliceId)) {
        throw new ValidationError("Personal tasks cannot belong to a project, requirement, or execution slice");
      }
      if (taskScope === "project" && taskInput.requirementId) {
        await routeRequirementForCreatedTask(
          tx as unknown as Database,
          taskInput.requirementId,
          taskInput.status ?? "todo",
          actor,
          { daemonId: taskInput.daemonId, leaseGeneration: taskInput.leaseGeneration },
        );
      }

      const [task] = await tx
        .insert(tasks)
        .values({
          scope: taskScope,
          projectId: taskInput.projectId,
          requirementId: taskInput.requirementId,
          executionSliceId: taskInput.executionSliceId,
          personalOwnerId: taskScope === "personal" ? (taskInput.personalOwnerId ?? actor.id) : null,
          personalOwnerType: taskScope === "personal" ? (taskInput.personalOwnerType ?? actor.type) : null,
          title: taskInput.title,
          description: taskInput.description,
          status: taskInput.status,
          priority: taskInput.priority,
          assignee: taskInput.assignee,
          assigneeType: taskInput.assigneeType,
          requestedProvider: taskInput.requestedProvider,
          requestedModel: taskInput.requestedModel,
          tags: taskInput.tags,
          expectedAt: batchExpectedAt,
          createdBy: actor.id,
        })
        .returning();

      await tx.insert(taskStatusLog).values({
        taskId: task!.id,
        fromStatus: null,
        toStatus: taskInput.status ?? "todo",
        changedBy: actor.id,
        changedByType: actor.type,
      });

      await tx.insert(activityLog).values({
        entityType: "task",
        entityId: task!.id,
        action: "created",
        actorId: actor.id,
        actorType: actor.type,
        metadata: { title: taskInput.title, status: taskInput.status ?? "todo", batch: true },
      });

      created.push(task!);
    }
    return created;
  });

  for (const task of results) {
    emit({ type: "task_created", projectId: task.projectId, taskId: task.id, title: task.title });
  }

  return results;
}

export async function batchUpdateTasks(
  db: Database,
  input: BatchUpdateTasksInput,
  actor: Actor,
) {
  const results = await db.transaction(async (tx) => {
    const updated = [];
    for (const update of input.updates) {
      const existing = await tx.query.tasks.findFirst({
        where: eq(tasks.id, update.id),
      });
      if (!existing) throw new NotFoundError(`Task not found: ${update.id}`);

      const { id, status, reason, ...fields } = update;
      const hasFieldUpdates = Object.keys(fields).length > 0;
      const hasStatusChange = status !== undefined && status !== existing.status;

      if (hasStatusChange) {
        if (existing.status === "cancelled") {
          throw new ValidationError(
            `Cannot change status of cancelled task ${id}`,
          );
        }

        const now = new Date();
        const [result] = await tx
          .update(tasks)
          .set({
            ...fields,
            status,
            completedAt: status === "done" ? now : null,
            updatedAt: now,
          })
          .where(eq(tasks.id, id))
          .returning();

        await tx.insert(taskStatusLog).values({
          taskId: id,
          fromStatus: existing.status,
          toStatus: status,
          changedBy: actor.id,
          changedByType: actor.type,
          reason,
        });

        await tx.insert(activityLog).values({
          entityType: "task",
          entityId: id,
          action: "status_changed",
          actorId: actor.id,
          actorType: actor.type,
          metadata: { from: existing.status, to: status, reason, batch: true },
        });

        updated.push(result!);
      } else if (hasFieldUpdates) {
        const [result] = await tx
          .update(tasks)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning();

        await tx.insert(activityLog).values({
          entityType: "task",
          entityId: id,
          action: "updated",
          actorId: actor.id,
          actorType: actor.type,
          metadata: { changes: fields, batch: true },
        });

        updated.push(result!);
      } else {
        updated.push(existing);
      }
    }
    return updated;
  });

  for (const task of results) {
    emit({ type: "task_updated", projectId: task.projectId, taskId: task.id });
  }

  return results;
}

export async function getKanbanBoard(
  db: Database,
  projectId: string,
  options: { includeTerminal?: boolean; completedWithinDays?: number } = {},
  authorizedPredicate?: SQL,
) {
  const includeTerminal = options.includeTerminal ?? false;
  const days = options.completedWithinDays ?? DEFAULT_COMPLETED_WITHIN_DAYS;

  const whereConditions = [eq(tasks.projectId, projectId), authorizedPredicate];
  if (!includeTerminal) {
    whereConditions.push(sql`${tasks.status} NOT IN ('done', 'cancelled')`);
  } else if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    whereConditions.push(
      sql`(${tasks.status} NOT IN ('done', 'cancelled') OR COALESCE(${tasks.completedAt}, ${tasks.updatedAt}) >= ${cutoff.toISOString()})`,
    );
  }

  const allTasks = await db.query.tasks.findMany({
    where: and(...whereConditions),
    with: {
      requirement: true,
      repositories: { with: { repository: true } },
    },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  const enrichedTasks = allTasks.map((t) => ({
    ...t,
    requirementTitle: (t as any).requirement?.title ?? "",
    requirementStatus: (t as any).requirement?.status ?? null,
  }));

  const statuses = [
    "todo",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
  ] as const;

  const labels: Record<string, string> = {
    todo: "To Do",
    in_progress: "In Progress",
    in_review: "In Review",
    done: "Done",
    cancelled: "Cancelled",
  };

  return {
    projectId,
    includeTerminal,
    completedWithinDays: days,
    columns: statuses.map((status) => {
      const columnTasks = enrichedTasks.filter((t) => t.status === status);
      return {
        status,
        label: labels[status],
        tasks: columnTasks,
        count: columnTasks.length,
      };
    }),
  };
}

export interface GanttTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  requirementId: string;
  requirementTitle: string;
  startDate: string;
  endDate: string;
  estimated: boolean;
  progress: number;
  dependencies: { taskId: string; type: string }[];
}

export interface GanttData {
  projectId: string;
  tasks: GanttTask[];
  requirements: { id: string; title: string; taskCount: number }[];
  dateRange: { start: string; end: string };
}

export async function getGanttChart(db: Database, projectId: string, authorizedPredicate?: SQL): Promise<GanttData> {
  const allTasks = await db.query.tasks.findMany({
    where: and(eq(tasks.scope, "project"), eq(tasks.projectId, projectId), authorizedPredicate),
    with: {
      requirement: true,
      dependencies: {
        with: { dependsOn: true },
      },
    },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  if (allTasks.length === 0) {
    const now = new Date().toISOString();
    return {
      projectId,
      tasks: [],
      requirements: [],
      dateRange: { start: now, end: now },
    };
  }

  const STATUS_PROGRESS: Record<string, number> = {
    todo: 0,
    in_progress: 40,
    in_review: 75,
    done: 100,
    cancelled: 100,
  };

  const ganttTasks: GanttTask[] = allTasks.map((t) => {
    const startDate = t.createdAt.toISOString();

    const hasActualEnd = !!t.completedAt && (t.status === "done" || t.status === "cancelled");
    const endDate = hasActualEnd
      ? t.completedAt!.toISOString()
      : t.expectedAt
        ? t.expectedAt.toISOString()
        : new Date(t.createdAt.getTime() + 7 * 86_400_000).toISOString();

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      requirementId: t.requirementId!,
      requirementTitle: (t as any).requirement?.title ?? "",
      startDate,
      endDate,
      estimated: !hasActualEnd,
      progress: STATUS_PROGRESS[t.status] ?? 0,
      dependencies: ((t as any).dependencies ?? []).filter((d: any) => allTasks.some(row => row.id === d.dependsOnTaskId)).map((d: any) => ({
        taskId: d.dependsOnTaskId,
        type: d.type,
      })),
    };
  });

  // Group by requirement
  const reqMap = new Map<string, { id: string; title: string; taskCount: number }>();
  for (const t of ganttTasks) {
    const existing = reqMap.get(t.requirementId);
    if (existing) {
      existing.taskCount++;
    } else {
      reqMap.set(t.requirementId, {
        id: t.requirementId,
        title: t.requirementTitle,
        taskCount: 1,
      });
    }
  }

  const allDates: Date[] = [];
  for (const gt of ganttTasks) {
    allDates.push(new Date(gt.startDate));
    allDates.push(new Date(gt.endDate));
  }
  const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime())));

  return {
    projectId,
    tasks: ganttTasks,
    requirements: Array.from(reqMap.values()),
    dateRange: {
      start: minDate.toISOString(),
      end: maxDate.toISOString(),
    },
  };
}
