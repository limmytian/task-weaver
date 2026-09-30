import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  type Database,
  requirements,
  requirementClaims,
  requirementDependencies,
  tasks,
  taskClaims,
  taskDependencies,
  activityLog,
} from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import type { Actor, RequirementLeaseFence } from "@task-weaver/contracts";
import { NotFoundError, ValidationError } from "@task-weaver/contracts";
import {
  assertRequirementStatusTransition,
  requirementStatePolicy,
} from "./daemon-state-machine";
import type { RequirementStatus } from "@task-weaver/contracts";

const DEFAULT_DURATION_MINUTES = 30;

export async function claimTask(
  db: Database,
  taskId: string,
  actor: Actor,
  durationMinutes: number = DEFAULT_DURATION_MINUTES,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);

  const { claim, projectId } = await db.transaction(async (tx) => {
    // Lock the task row to serialize concurrent claims
    const rows = await tx.execute(
      sql`SELECT id, status, assignee, project_id FROM tasks WHERE id = ${taskId} FOR UPDATE`,
    );
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) throw new NotFoundError("Task not found");

    const status = row.status as string;
    if (status === "cancelled" || status === "done") {
      throw new ValidationError(`Cannot claim a task with status '${status}'`);
    }

    // Clean expired claims under the lock
    await tx
      .delete(taskClaims)
      .where(and(eq(taskClaims.taskId, taskId), lt(taskClaims.expiresAt, now)));

    const existing = await tx.query.taskClaims.findFirst({
      where: eq(taskClaims.taskId, taskId),
    });

    if (existing) {
      if (existing.claimedBy === actor.id) {
        const [updated] = await tx
          .update(taskClaims)
          .set({ expiresAt, heartbeatAt: now })
          .where(eq(taskClaims.id, existing.id))
          .returning();
        return { claim: updated!, projectId: (row.project_id ?? row.projectId) as string };
      }
      throw new ValidationError(
        `Task is already claimed by '${existing.claimedBy}' until ${existing.expiresAt.toISOString()}. ` +
        `Wait for the claim to expire or ask them to release it.`,
      );
    }

    const [inserted] = await tx
      .insert(taskClaims)
      .values({
        taskId,
        claimedBy: actor.id,
        claimedByType: actor.type,
        expiresAt,
        heartbeatAt: now,
      })
      .returning();

    if (!row.assignee) {
      await tx
        .update(tasks)
        .set({ assignee: actor.id, assigneeType: actor.type, updatedAt: now })
        .where(eq(tasks.id, taskId));
    }

    await tx.insert(activityLog).values({
      entityType: "task",
      entityId: taskId,
      action: "claimed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: { durationMinutes, expiresAt: expiresAt.toISOString() },
    });

    return { claim: inserted!, projectId: (row.project_id ?? row.projectId) as string };
  });

  emit({ type: "task_claimed", projectId, taskId, claimedBy: actor.id });

  return claim;
}

export async function releaseTask(
  db: Database,
  taskId: string,
  actor: Actor,
  reason?: string,
) {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new NotFoundError("Task not found");

  const existing = await db.query.taskClaims.findFirst({
    where: eq(taskClaims.taskId, taskId),
  });

  if (!existing) {
    throw new ValidationError("Task is not currently claimed");
  }

  if (existing.claimedBy !== actor.id) {
    throw new ValidationError(
      `Only the claim holder '${existing.claimedBy}' can release this task`,
    );
  }

  await db.delete(taskClaims).where(eq(taskClaims.id, existing.id));

  await db.insert(activityLog).values({
    entityType: "task",
    entityId: taskId,
    action: "released",
    actorId: actor.id,
    actorType: actor.type,
    metadata: reason ? { reason } : undefined,
  });

  emit({ type: "task_released", projectId: task.projectId, taskId });

  return { released: true };
}

export async function heartbeatClaim(
  db: Database,
  taskId: string,
  actor: Actor,
  extendMinutes: number = DEFAULT_DURATION_MINUTES,
) {
  const existing = await db.query.taskClaims.findFirst({
    where: eq(taskClaims.taskId, taskId),
  });

  if (!existing) {
    throw new NotFoundError("No active claim found for this task");
  }

  if (existing.claimedBy !== actor.id) {
    throw new ValidationError(
      `Only the claim holder '${existing.claimedBy}' can send heartbeat`,
    );
  }

  const now = new Date();
  const newExpiry = new Date(now.getTime() + extendMinutes * 60_000);

  const [updated] = await db
    .update(taskClaims)
    .set({ heartbeatAt: now, expiresAt: newExpiry })
    .where(eq(taskClaims.id, existing.id))
    .returning();

  return updated!;
}

export async function getTaskClaim(db: Database, taskId: string) {
  const now = new Date();

  // Clean expired
  await db
    .delete(taskClaims)
    .where(and(eq(taskClaims.taskId, taskId), lt(taskClaims.expiresAt, now)));

  return db.query.taskClaims.findFirst({
    where: eq(taskClaims.taskId, taskId),
  }) ?? null;
}

export async function listActiveClaims(
  db: Database,
  filters?: { projectId?: string; claimedBy?: string },
) {
  const now = new Date();

  // Clean all expired claims
  await db.delete(taskClaims).where(lt(taskClaims.expiresAt, now));

  const conditions = [gt(taskClaims.expiresAt, now)];

  if (filters?.claimedBy) {
    conditions.push(eq(taskClaims.claimedBy, filters.claimedBy));
  }

  const claims = await db.query.taskClaims.findMany({
    where: and(...conditions),
    with: { task: true },
  });

  if (filters?.projectId) {
    return claims.filter((c: any) => c.task?.projectId === filters.projectId);
  }

  return claims;
}

export async function claimRequirement(
  db: Database,
  requirementId: string,
  actor: Actor,
  durationMinutes: number = DEFAULT_DURATION_MINUTES,
  metadata?: { daemonId?: string; workerIndex?: string | number },
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);

  const { claim, projectId } = await db.transaction(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, status, project_id, lease_generation FROM requirements WHERE id = ${requirementId} FOR UPDATE`,
    );
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) throw new NotFoundError("Requirement not found");

    const status = row.status as RequirementStatus;
    const statusPolicy = requirementStatePolicy(status);
    if (statusPolicy.terminal) {
      throw new ValidationError(`Cannot claim a requirement with status '${status}'`);
    }
    if (statusPolicy.phase === "planning") {
      throw new ValidationError(`Cannot claim a requirement with status '${status}'; approve it first`);
    }

    const blockerRows = await tx
      .select({
        title: requirements.title,
        status: requirements.status,
      })
      .from(requirementDependencies)
      .innerJoin(requirements, eq(requirementDependencies.dependsOnRequirementId, requirements.id))
      .where(
        and(
          eq(requirementDependencies.requirementId, requirementId),
          eq(requirementDependencies.type, "blocks"),
          sql`${requirements.status} NOT IN ('done', 'cancelled')`,
        ),
      );

    if (blockerRows.length > 0) {
      const blockerList = blockerRows.map((b) => `"${b.title}" (${b.status})`).join(", ");
      throw new ValidationError(
        `Cannot claim requirement: blocked by unfinished requirements: ${blockerList}.`,
      );
    }

    await tx
      .delete(requirementClaims)
      .where(and(eq(requirementClaims.requirementId, requirementId), lt(requirementClaims.expiresAt, now)));

    const existing = await tx.query.requirementClaims.findFirst({
      where: eq(requirementClaims.requirementId, requirementId),
    });

    if (existing) {
      const sameActor =
        existing.claimedBy === actor.id &&
        existing.claimedByType === actor.type;
      const sameDaemon =
        metadata?.daemonId === undefined ||
        existing.daemonId === null ||
        existing.daemonId === metadata.daemonId;
      if (sameActor && sameDaemon) {
        const generation = existing.generation ?? Number(row.lease_generation ?? row.leaseGeneration ?? 1);
        const [updated] = await tx
          .update(requirementClaims)
          .set({
            expiresAt,
            heartbeatAt: now,
            daemonId: metadata?.daemonId ?? existing.daemonId,
            workerIndex: metadata?.workerIndex !== undefined ? String(metadata.workerIndex) : existing.workerIndex,
            generation,
          })
          .where(eq(requirementClaims.id, existing.id))
          .returning();
        return { claim: updated!, projectId: (row.project_id ?? row.projectId) as string };
      }
      throw new ValidationError(
        `Requirement is already claimed by '${existing.claimedBy}'` +
        `${existing.daemonId ? ` through daemon instance '${existing.daemonId}'` : ""}` +
        ` until ${existing.expiresAt.toISOString()}. ` +
        `Wait for the claim to expire or ask them to release it.`,
      );
    }

    const generation = Number(row.lease_generation ?? row.leaseGeneration ?? 0) + 1;
    if (status === "approved") {
      assertRequirementStatusTransition(status, "in_progress");
    }
    await tx
      .update(requirements)
      .set({
        leaseGeneration: generation,
        ...(status === "approved" ? { status: "in_progress" as const } : {}),
        updatedAt: now,
      })
      .where(eq(requirements.id, requirementId));

    const [inserted] = await tx
      .insert(requirementClaims)
      .values({
        requirementId,
        claimedBy: actor.id,
        claimedByType: actor.type,
        daemonId: metadata?.daemonId,
        workerIndex: metadata?.workerIndex !== undefined ? String(metadata.workerIndex) : undefined,
        generation,
        expiresAt,
        heartbeatAt: now,
      })
      .returning();

    await tx.insert(activityLog).values({
      entityType: "requirement",
      entityId: requirementId,
      action: "claimed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: {
        durationMinutes,
        expiresAt: expiresAt.toISOString(),
        daemonId: metadata?.daemonId,
        workerIndex: metadata?.workerIndex,
        leaseGeneration: generation,
      },
    });

    return { claim: inserted!, projectId: (row.project_id ?? row.projectId) as string };
  });

  emit({ type: "requirement_claimed", projectId, requirementId, claimedBy: actor.id });

  return claim;
}

function assertRequirementClaimOwner(
  existing: typeof requirementClaims.$inferSelect,
  actor: Actor,
  fence?: RequirementLeaseFence,
) {
  const legacyDaemonActor = existing.daemonId != null && existing.daemonId === actor.id;
  const sameActor = existing.claimedBy === actor.id && existing.claimedByType === actor.type;
  if (!sameActor && !legacyDaemonActor) {
    throw new ValidationError(`Only claim holder '${existing.claimedBy}' may mutate this requirement lane`);
  }

  if (existing.daemonId != null) {
    if (!fence?.daemonId || fence.leaseGeneration === undefined) {
      throw new ValidationError("Daemon-owned Requirement mutations require daemonId and leaseGeneration");
    }
    if (fence.daemonId !== existing.daemonId) {
      throw new ValidationError(`Stale or wrong daemon instance '${fence.daemonId}' for this Requirement lease`);
    }
  }
  if (fence?.leaseGeneration !== undefined && fence.leaseGeneration !== existing.generation) {
    throw new ValidationError(
      `Stale Requirement lease generation ${fence.leaseGeneration}; active generation is ${existing.generation}`,
    );
  }
}

export async function assertRequirementLease(
  db: Database,
  requirementId: string,
  actor: Actor,
  fence?: RequirementLeaseFence,
  requireActive: boolean = false,
) {
  const existing = await db.query.requirementClaims.findFirst({
    where: and(
      eq(requirementClaims.requirementId, requirementId),
      gt(requirementClaims.expiresAt, new Date()),
    ),
  });
  if (!existing) {
    if (requireActive || fence?.daemonId || fence?.leaseGeneration !== undefined) {
      throw new ValidationError("No active Requirement lease matches this mutation");
    }
    return null;
  }
  assertRequirementClaimOwner(existing, actor, fence);
  return existing;
}

export async function releaseRequirement(
  db: Database,
  requirementId: string,
  actor: Actor,
  reason?: string,
  daemonId?: string,
  leaseGeneration?: number,
) {
  const requirement = await db.query.requirements.findFirst({ where: eq(requirements.id, requirementId) });
  if (!requirement) throw new NotFoundError("Requirement not found");

  const existing = await db.query.requirementClaims.findFirst({
    where: eq(requirementClaims.requirementId, requirementId),
  });

  if (!existing) {
    throw new ValidationError("Requirement is not currently claimed");
  }

  if (existing.expiresAt <= new Date()) throw new ValidationError("Requirement lease has expired");
  assertRequirementClaimOwner(existing, actor, { daemonId, leaseGeneration });

  await db.delete(requirementClaims).where(eq(requirementClaims.id, existing.id));

  await db.insert(activityLog).values({
    entityType: "requirement",
    entityId: requirementId,
    action: "released",
    actorId: actor.id,
    actorType: actor.type,
    metadata: reason || daemonId
      ? { ...(reason ? { reason } : {}), ...(daemonId ? { daemonId } : {}), leaseGeneration }
      : undefined,
  });

  emit({ type: "requirement_released", projectId: requirement.projectId, requirementId });

  return { released: true };
}

export async function heartbeatRequirementClaim(
  db: Database,
  requirementId: string,
  actor: Actor,
  extendMinutes: number = DEFAULT_DURATION_MINUTES,
  daemonId?: string,
  leaseGeneration?: number,
) {
  const existing = await db.query.requirementClaims.findFirst({
    where: eq(requirementClaims.requirementId, requirementId),
  });

  if (!existing) {
    throw new NotFoundError("No active claim found for this requirement");
  }

  if (existing.expiresAt <= new Date()) throw new ValidationError("Requirement lease has expired");
  assertRequirementClaimOwner(existing, actor, { daemonId, leaseGeneration });

  const now = new Date();
  const newExpiry = new Date(now.getTime() + extendMinutes * 60_000);

  const [updated] = await db
    .update(requirementClaims)
    .set({ heartbeatAt: now, expiresAt: newExpiry })
    .where(eq(requirementClaims.id, existing.id))
    .returning();

  return updated!;
}

export async function getRequirementClaim(db: Database, requirementId: string) {
  const now = new Date();

  await db
    .delete(requirementClaims)
    .where(and(eq(requirementClaims.requirementId, requirementId), lt(requirementClaims.expiresAt, now)));

  return db.query.requirementClaims.findFirst({
    where: eq(requirementClaims.requirementId, requirementId),
  }) ?? null;
}

export async function listActiveRequirementClaims(
  db: Database,
  filters?: { projectId?: string; claimedBy?: string },
) {
  const now = new Date();

  await db.delete(requirementClaims).where(lt(requirementClaims.expiresAt, now));

  const conditions = [gt(requirementClaims.expiresAt, now)];

  if (filters?.claimedBy) {
    conditions.push(eq(requirementClaims.claimedBy, filters.claimedBy));
  }

  const claims = await db.query.requirementClaims.findMany({
    where: and(...conditions),
    with: { requirement: true },
  });

  if (filters?.projectId) {
    return claims.filter((c: any) => c.requirement?.projectId === filters.projectId);
  }

  return claims;
}

/**
 * Atomically claim multiple tasks inside a single transaction.
 *
 * Uses SELECT ... FOR UPDATE on task rows to serialize concurrent batch
 * claims — if two agents race on overlapping tasks, one blocks until the
 * other commits/rollbacks, eliminating the TOCTOU gap.
 *
 * 1. Lock all task rows (FOR UPDATE).
 * 2. Validate ALL tasks, collecting every problem (not just the first).
 * 3. If any problems, throw with the full list — transaction rolls back.
 * 4. If clean, insert/extend all claims atomically.
 *
 * Already-held claims by the same actor are silently extended.
 */
export async function batchClaimTasks(
  db: Database,
  taskIds: string[],
  actor: Actor,
  durationMinutes: number = DEFAULT_DURATION_MINUTES,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);

  const { claimed, projectIds } = await db.transaction(async (tx) => {
    // Clean expired claims for requested tasks
    for (const taskId of taskIds) {
      await tx
        .delete(taskClaims)
        .where(and(eq(taskClaims.taskId, taskId), lt(taskClaims.expiresAt, now)));
    }

    // Phase 1: lock rows + validate all, collect ALL problems
    const problems: { taskId: string; reason: string }[] = [];
    const taskMap = new Map<string, { status: string; assignee: string | null; projectId: string }>();
    const existingClaimMap = new Map<string, { id: string; claimedBy: string; expiresAt: Date }>();

    for (const taskId of taskIds) {
      const rows = await tx.execute(
        sql`SELECT id, status, assignee, project_id FROM tasks WHERE id = ${taskId} FOR UPDATE`,
      );
      const row = (rows as unknown as Record<string, unknown>[])[0];

      if (!row) {
        problems.push({ taskId, reason: "not found" });
        continue;
      }

      const status = row.status as string;
      const projectId = (row.project_id ?? row.projectId) as string;
      const assignee = (row.assignee ?? null) as string | null;
      taskMap.set(taskId, { status, assignee, projectId });

      if (status === "cancelled" || status === "done") {
        problems.push({ taskId, reason: `status is '${status}'` });
        continue;
      }

      const existing = await tx.query.taskClaims.findFirst({
        where: eq(taskClaims.taskId, taskId),
      });

      if (existing) {
        if (existing.claimedBy !== actor.id) {
          problems.push({
            taskId,
            reason: `claimed by '${existing.claimedBy}' until ${existing.expiresAt.toISOString()}`,
          });
        } else {
          existingClaimMap.set(taskId, existing);
        }
      }
    }

    if (problems.length > 0) {
      throw new ValidationError(
        JSON.stringify({ message: "Batch claim failed. No tasks were claimed.", problems }),
      );
    }

    // Phase 2: all validated under row locks — safe to claim
    const claimedResults = [];
    const pIds = new Map<string, string>();

    for (const taskId of taskIds) {
      const task = taskMap.get(taskId)!;
      pIds.set(taskId, task.projectId);

      const existing = existingClaimMap.get(taskId);
      if (existing) {
        const [updated] = await tx
          .update(taskClaims)
          .set({ expiresAt, heartbeatAt: now })
          .where(eq(taskClaims.id, existing.id))
          .returning();
        claimedResults.push(updated!);
        continue;
      }

      const [claim] = await tx
        .insert(taskClaims)
        .values({
          taskId,
          claimedBy: actor.id,
          claimedByType: actor.type,
          expiresAt,
          heartbeatAt: now,
        })
        .returning();

      if (!task.assignee) {
        await tx
          .update(tasks)
          .set({ assignee: actor.id, assigneeType: actor.type, updatedAt: now })
          .where(eq(tasks.id, taskId));
      }

      await tx.insert(activityLog).values({
        entityType: "task",
        entityId: taskId,
        action: "claimed",
        actorId: actor.id,
        actorType: actor.type,
        metadata: { durationMinutes, expiresAt: expiresAt.toISOString(), batch: true },
      });

      claimedResults.push(claim!);
    }

    return { claimed: claimedResults, projectIds: pIds };
  });

  // Emit events after transaction commits
  for (const taskId of taskIds) {
    const projectId = projectIds.get(taskId);
    if (projectId) {
      emit({ type: "task_claimed", projectId, taskId, claimedBy: actor.id });
    }
  }

  return claimed;
}

/**
 * Check if a task has unfinished blocking dependencies.
 * Returns the list of blocking tasks that are not yet done.
 */
export async function checkBlockingDependencies(
  db: Database,
  taskId: string,
) {
  const deps = await db.query.taskDependencies.findMany({
    where: eq(taskDependencies.taskId, taskId),
    with: { dependsOn: true },
  });

  return deps
    .filter((d: any) => d.type === "blocks" && d.dependsOn?.status !== "done")
    .map((d: any) => ({
      taskId: d.dependsOnTaskId,
      title: d.dependsOn?.title,
      status: d.dependsOn?.status,
    }));
}
