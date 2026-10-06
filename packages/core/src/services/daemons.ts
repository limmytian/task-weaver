import type { MetadataReadScope } from "./metadata-read-scope";
import { and, eq, gt, inArray, lt, not, sql, type SQL } from "drizzle-orm";
import {
  activityLog,
  type Database,
  daemonWorkerProgress,
  daemons,
  executionSlices,
  tasks,
  requirements,
  requirementClaims,
} from "@task-weaver/db";
import { ConflictError, NotFoundError, ValidationError } from "@task-weaver/contracts";
import {
  claimRequirement,
  claimTask,
  releaseRequirement,
  releaseTask,
} from "./claims";
import { updateTaskStatus } from "./tasks";
import { DAEMON_QUEUE_REQUIREMENT_STATUSES } from "./daemon-state-machine";
import { getDaemonConfig } from "./daemon-config";
import type { Actor } from "@task-weaver/contracts";
import type {
  DaemonRole,
  DaemonControlAction,
  DaemonControlState,
  DaemonWorkerState,
  RegisterDaemonInput,
  SchedulerEligibilityDiagnostics,
  SchedulerEligibilityReason,
} from "@task-weaver/contracts";
import { emit } from "@task-weaver/realtime";
import { reconcileInterruptedWorker } from "./daemon-progress";
import { matchDaemonTaskCapabilities } from "./daemon-capabilities";
import {
  classifyDaemonQueueRequirement,
  type DaemonQueueDaemonInput,
  type DaemonQueueItem,
  type DaemonQueueRequirementInput,
} from "./daemon-control-plane";

function trustedStatusSql(statuses: readonly string[]) {
  return sql.raw(statuses.map((status) => `'${status}'`).join(", "));
}

const EXECUTOR_REQUIREMENT_STATUSES_SQL = trustedStatusSql(DAEMON_QUEUE_REQUIREMENT_STATUSES.executor);
const REVIEWER_REQUIREMENT_STATUS_SQL = trustedStatusSql(DAEMON_QUEUE_REQUIREMENT_STATUSES.reviewer);
const MERGER_REQUIREMENT_STATUS_SQL = trustedStatusSql(DAEMON_QUEUE_REQUIREMENT_STATUSES.merger);
const ACQUISITION_CANDIDATE_LIMIT = 200;
const ELIGIBILITY_CANDIDATE_LIMIT = 200;
const ELIGIBILITY_SAMPLE_LIMIT = 20;
const ELIGIBILITY_REASONS: SchedulerEligibilityReason[] = [
  "status",
  "dependency",
  "claim",
  "slice_order",
  "capability",
  "model_tier",
  "retry_time",
  "policy",
];

export function schedulerPriorityRank(
  priority: "critical" | "urgent" | "high" | "medium" | "low",
  createdAt: Date,
  now = new Date(),
) {
  const base = priority === "critical" || priority === "urgent"
    ? 0
    : priority === "high"
      ? 1
      : priority === "medium"
        ? 2
        : 3;
  const waitedDays = Math.min(
    3,
    Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000)),
  );
  return Math.max(0, base - waitedDays);
}

type DaemonRecord = {
  id: string;
  role?: DaemonRole | null;
  actorId?: string | null;
  actorType?: "human" | "agent" | null;
  processStartedAt?: Date | null;
  lastHeartbeatAt: Date;
  controlState?: DaemonControlState | null;
};

function daemonView<T extends { id: string }>(daemon: T): T & { instanceId: string } {
  return { ...daemon, instanceId: daemon.id };
}

function emitDaemonStatus(daemon: any) {
  emit({
    type: "daemon_status_changed",
    daemonId: daemon.id,
    instanceId: daemon.id,
    role: daemon.role ?? "executor",
    actorId: daemon.actorId ?? null,
    actorType: daemon.actorType ?? null,
    host: daemon.host ?? null,
    processStartedAt: daemon.processStartedAt ?? null,
    workerCapacity: daemon.workerCapacity ?? 1,
    status: daemon.status,
    controlState: daemon.controlState ?? "running",
    controlReason: daemon.controlReason ?? null,
    activeTaskIds: daemon.activeTaskIds ?? [],
    activeWorkerStates: Array.isArray(daemon.activeWorkerStates)
      ? daemon.activeWorkerStates
      : [],
  });
}

function daemonActor(daemon: DaemonRecord): Actor {
  return {
    id: daemon.actorId ?? daemon.id,
    type: daemon.actorType ?? "agent",
  };
}

function assertDaemonActor(daemon: DaemonRecord, actor: Actor) {
  if (!daemon.actorId || actor.id !== daemon.actorId || actor.type !== daemon.actorType) {
    throw new ValidationError(
      `Daemon instance '${daemon.id}' belongs to actor '${daemon.actorId ?? daemon.id}'`,
    );
  }
}

function assertDaemonRole(daemon: DaemonRecord, expectedRole: DaemonRole) {
  const role = daemon.role ?? "executor";
  if (role !== expectedRole) {
    throw new ValidationError(
      `Daemon role '${role}' cannot acquire '${expectedRole}' work`,
    );
  }
}

function daemonAcceptsWork(daemon: DaemonRecord) {
  return (daemon.controlState ?? "running") === "running";
}

export async function requestDaemonControl(
  db: Database,
  id: string,
  action: DaemonControlAction,
  reason: string,
  actor: Actor,
) {
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, id) });
  if (!daemon) throw new NotFoundError("Daemon not found");
  if (daemon.status === "offline") {
    throw new ValidationError("Offline daemons cannot accept lifecycle controls");
  }

  const current = daemon.controlState ?? "running";
  const target: DaemonControlState = action === "pause"
    ? "paused"
    : action === "drain"
      ? "draining"
      : "running";
  if (current === target) return daemonView(daemon);
  if (action === "pause" && current !== "running") {
    throw new ValidationError(`Daemon cannot pause while control state is '${current}'`);
  }
  if (action === "drain" && current !== "running" && current !== "paused") {
    throw new ValidationError(`Daemon cannot drain while control state is '${current}'`);
  }
  if (action === "resume" && current === "running") {
    throw new ValidationError("Daemon is already accepting work");
  }

  const now = new Date();
  const [updated] = await db.update(daemons).set({
    controlState: target,
    controlReason: reason,
    controlRequestedAt: now,
    controlRequestedBy: actor.id,
    controlRequestedByType: actor.type,
    updatedAt: now,
  }).where(and(
    eq(daemons.id, id),
    eq(daemons.controlState, current),
  )).returning();
  if (!updated) {
    throw new ConflictError("Daemon control state changed while the action was being requested", 0);
  }

  await db.insert(activityLog).values({
    entityType: "daemon",
    entityId: id,
    action: "control_requested",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      instanceId: id,
      role: daemon.role ?? "executor",
      command: action,
      reason,
      from: current,
      to: target,
      activeWorkers: Array.isArray(daemon.activeWorkerStates)
        ? daemon.activeWorkerStates.filter((worker: any) =>
            worker.status !== "idle" || Boolean(worker.requirementId),
          ).length
        : 0,
    },
  });
  emitDaemonStatus(updated);
  return daemonView(updated);
}

export async function registerDaemon(
  db: Database,
  input: RegisterDaemonInput,
  actor: Actor,
) {
  const now = new Date();
  const config = getDaemonConfig();
  const processStartedAt = input.processStartedAt
    ? new Date(input.processStartedAt)
    : now;

  if (input.id) {
    const existing = await db.query.daemons.findFirst({
      where: eq(daemons.id, input.id),
    });

    if (existing) {
      if (!existing.actorId || existing.actorId !== actor.id || existing.actorType !== actor.type) {
        throw new ValidationError(
          `Daemon instance '${existing.id}' belongs to actor '${existing.actorId}'`,
        );
      }

      const existingRole = existing.role ?? "executor";
      const adoptingLegacyIdentity = !existing.actorId;
      if (!adoptingLegacyIdentity && existingRole !== input.role) {
        throw new ValidationError(
          `Daemon instance '${existing.id}' is registered as role '${existingRole}'`,
        );
      }

      const isLive = existing.lastHeartbeatAt.getTime() > now.getTime() - 60_000;
      if (
        input.processStartedAt &&
        existing.processStartedAt &&
        existing.processStartedAt.getTime() !== processStartedAt.getTime() &&
        isLive
      ) {
        throw new ValidationError(
          `Daemon instance '${existing.id}' is already active from another process`,
        );
      }

      const [updated] = await db
        .update(daemons)
        .set({
          name: input.name,
          role: adoptingLegacyIdentity ? input.role : existingRole,
          actorId: existing.actorId ?? actor.id,
          actorType: existing.actorType ?? actor.type,
          capabilities: input.capabilities,
          host: input.host ?? existing.host,
          processStartedAt: isLive
            ? existing.processStartedAt
            : processStartedAt,
          workerCapacity: input.workerCapacity,
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(daemons.id, input.id))
        .returning();
      await db.insert(activityLog).values({
        entityType: "daemon",
        entityId: updated!.id,
        action: "registered",
        actorId: actor.id,
        actorType: actor.type,
        metadata: {
          instanceId: updated!.id,
          role: updated!.role,
          host: updated!.host,
          processStartedAt: updated!.processStartedAt,
          workerCapacity: updated!.workerCapacity,
          reRegistered: true,
        },
      });
      emitDaemonStatus(updated!);
      return { ...daemonView(updated!), config };
    }
  }

  const [inserted] = await db
    .insert(daemons)
    .values({
      id: input.id,
      name: input.name,
      role: input.role,
      actorId: actor.id,
      actorType: actor.type,
      capabilities: input.capabilities,
      host: input.host,
      processStartedAt,
      workerCapacity: input.workerCapacity,
      status: "idle",
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      activeWorkerStates: [],
    })
    .returning();
  await db.insert(activityLog).values({
    entityType: "daemon",
    entityId: inserted!.id,
    action: "registered",
    actorId: actor.id,
    actorType: actor.type,
    metadata: {
      instanceId: inserted!.id,
      role: inserted!.role,
      host: inserted!.host,
      processStartedAt: inserted!.processStartedAt,
      workerCapacity: inserted!.workerCapacity,
      reRegistered: false,
    },
  });
  emitDaemonStatus(inserted!);
  return { ...daemonView(inserted!), config };
}

export async function heartbeatDaemon(db: Database, id: string, actor?: Actor) {
  const now = new Date();
  if (actor) {
    const daemon = await db.query.daemons.findFirst({
      where: eq(daemons.id, id),
    });
    if (!daemon) throw new NotFoundError("Daemon not found");
    assertDaemonActor(daemon, actor);
  }
  const [updated] = await db
    .update(daemons)
    .set({
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(daemons.id, id))
    .returning();

  if (!updated) {
    throw new NotFoundError("Daemon not found");
  }
  return daemonView(updated);
}

export async function updateDaemonStatus(
  db: Database,
  id: string,
  status: "idle" | "busy" | "offline",
  activeTaskIds?: string[],
  activeWorkerStates?: DaemonWorkerState[],
  actor?: Actor,
) {
  const now = new Date();
  const existing = await db.query.daemons.findFirst({
    where: eq(daemons.id, id),
  });
  if (!existing) throw new NotFoundError("Daemon not found");
  if (actor) assertDaemonActor(existing, actor);
  const previousStatus = existing.status;
  const updateFields: Record<string, any> = {
    status,
    lastHeartbeatAt: now,
    updatedAt: now,
  };

  if (activeTaskIds !== undefined) {
    updateFields.activeTaskIds = activeTaskIds;
  }
  if (activeWorkerStates !== undefined) {
    updateFields.activeWorkerStates = activeWorkerStates;
  }
  const reportedWorkers = activeWorkerStates !== undefined
    ? activeWorkerStates
    : Array.isArray(existing.activeWorkerStates)
      ? existing.activeWorkerStates as DaemonWorkerState[]
      : [];
  const hasActiveWorkers = reportedWorkers.some((worker) =>
    worker.status !== "idle" || Boolean(worker.requirementId),
  );
  if ((existing.controlState ?? "running") === "draining" && status !== "busy" && !hasActiveWorkers) {
    updateFields.controlState = "drained";
  }

  const [updated] = await db
    .update(daemons)
    .set(updateFields)
    .where(eq(daemons.id, id))
    .returning();

  if (!updated) {
    throw new NotFoundError("Daemon not found");
  }

  if (previousStatus !== status) {
    const statusActor = actor ?? daemonActor(existing);
    await db.insert(activityLog).values({
      entityType: "daemon",
      entityId: id,
      action: "status_changed",
      actorId: statusActor.id,
      actorType: statusActor.type,
      metadata: {
        instanceId: id,
        role: existing.role ?? "executor",
        from: previousStatus,
        to: status,
        host: existing.host,
        processStartedAt: existing.processStartedAt,
        workerCapacity: existing.workerCapacity,
      },
    });
  }

  emitDaemonStatus(updated);
  return daemonView(updated);
}

const DAEMON_OFFLINE_RETAIN_HOURS = 24;

export async function cleanExpiredDaemons(db: Database) {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);

  // Find all daemons that haven't sent heartbeats in 1 minute and are not offline
  const expired = await db.query.daemons.findMany({
    where: and(
      lt(daemons.lastHeartbeatAt, oneMinuteAgo),
      not(eq(daemons.status, "offline")),
    ),
  });

  for (const d of expired) {
    const actor = daemonActor(d);
    const workerStates = Array.isArray(d.activeWorkerStates)
      ? d.activeWorkerStates as DaemonWorkerState[]
      : [];
    const progressRows = await db.query.daemonWorkerProgress.findMany({
      where: eq(daemonWorkerProgress.daemonId, d.id),
    });

    // Release all active requirement lanes and task claims if the daemon was busy.
    if (
      d.status === "busy"
      && (workerStates.length > 0 || progressRows.length > 0 || (d.activeTaskIds && d.activeTaskIds.length > 0))
    ) {
      const lanes = new Map<string, { state?: DaemonWorkerState; progress?: any }>();
      for (const state of workerStates) {
        if (state.requirementId) lanes.set(state.requirementId, { state });
      }
      for (const progress of progressRows) {
        const lane = lanes.get(progress.requirementId) ?? {};
        lane.progress = progress;
        lanes.set(progress.requirementId, lane);
      }

      for (const [requirementId, lane] of lanes) {
        const { state, progress } = lane;
        try {
          const activeClaim = await db.query.requirementClaims.findFirst({
            where: eq(requirementClaims.requirementId, requirementId),
          });
          const requirement = await db.query.requirements.findFirst({
            where: eq(requirements.id, requirementId),
          });
          const leaseGeneration = progress?.leaseGeneration
            ?? state?.leaseGeneration
            ?? activeClaim?.generation;
          const workerIndex = progress?.workerIndex
            ?? state?.index
            ?? (state as any)?.workerIndex
            ?? Number(activeClaim?.workerIndex ?? 0);
          const runId = progress?.runId ?? activeClaim?.id;
          const claimMatches = !activeClaim || (
            activeClaim.daemonId === d.id
            && activeClaim.generation === leaseGeneration
            && (!progress?.runId || activeClaim.id === progress.runId)
          );
          const generationMatches = requirement?.leaseGeneration === leaseGeneration;
          if (!claimMatches || !generationMatches || !runId || !leaseGeneration) {
            console.warn(`Skipped stale worker recovery for requirement ${requirementId} on daemon ${d.id}`);
            continue;
          }

          await reconcileInterruptedWorker(
            db,
            d,
            {
              runId,
              workerIndex,
              requirementId,
              executionSliceId: progress?.executionSliceId ?? state?.executionSliceId ?? null,
              currentTaskId: progress?.currentTaskId ?? state?.taskId ?? null,
              leaseGeneration,
              reason: "Daemon heartbeat timeout",
              workspaceState: progress?.workspaceState ?? "unknown",
              pendingDiffSummary: progress?.pendingDiffSummary ?? null,
              sliceSummary: progress?.sliceSummary ?? null,
              handoffSummary: progress?.handoffSummary ?? null,
            },
            actor,
          );

          if (activeClaim) {
            await db.delete(requirementClaims).where(eq(requirementClaims.id, activeClaim.id));
            await db.insert(activityLog).values({
              entityType: "requirement",
              entityId: requirementId,
              action: "released",
              actorId: actor.id,
              actorType: actor.type,
              metadata: {
                reason: "Daemon heartbeat timeout after deterministic recovery",
                daemonId: d.id,
                leaseGeneration,
                runId,
              },
            });
            if (requirement) {
              emit({
                type: "requirement_released",
                projectId: requirement.projectId,
                requirementId,
              });
            }
          }
        } catch (err) {
          console.warn(`Failed to reconcile requirement ${requirementId} for expired daemon ${d.id}:`, err);
        }
      }

      for (const taskId of d.activeTaskIds) {
        try {
          const task = await db.query.tasks.findFirst({
            where: eq(tasks.id, taskId),
          });
          if (task?.status === "in_progress") {
            await updateTaskStatus(
              db,
              taskId,
              "todo",
              actor,
              "Daemon heartbeat timeout — reverting to todo for retry",
            );
          }
          await releaseTask(db, taskId, actor, "Daemon heartbeat timeout");
        } catch (err) {
          // Task might already be released or completed
          console.warn(`Failed to release task ${taskId} for expired daemon ${d.id}:`, err);
        }
      }
    }

    await db
      .update(daemons)
      .set({
        status: "offline",
        activeTaskIds: [],
        activeWorkerStates: [],
        updatedAt: now,
      })
      .where(eq(daemons.id, d.id));

    await db.insert(activityLog).values({
      entityType: "daemon",
      entityId: d.id,
      action: "status_changed",
      actorId: actor.id,
      actorType: actor.type,
      metadata: {
        instanceId: d.id,
        role: d.role ?? "executor",
        from: d.status,
        to: "offline",
        reason: "heartbeat_timeout",
      },
    });
    emitDaemonStatus({
      ...d,
      status: "offline",
      activeTaskIds: [],
      activeWorkerStates: [],
      updatedAt: now,
    });
  }

  // Hard-delete offline rows older than the retention window
  const retainCutoff = new Date(now.getTime() - DAEMON_OFFLINE_RETAIN_HOURS * 3_600_000);
  await db
    .delete(daemons)
    .where(
      and(
        eq(daemons.status, "offline"),
        lt(daemons.updatedAt, retainCutoff),
      ),
    );
}

export async function listOnlineDaemons(db: Database) {
  await cleanExpiredDaemons(db);

  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);

  const rows = await db.query.daemons.findMany({
    where: and(
      gt(daemons.lastHeartbeatAt, oneMinuteAgo),
      not(eq(daemons.status, "offline")),
    ),
    orderBy: daemons.name,
  });

  return Promise.all(rows.map((daemon) => enrichDaemonWorkerStates(db, daemon)));
}

export async function listDaemonControlPlaneQueues(db: Database, scope?: MetadataReadScope) {
  if (!scope) await cleanExpiredDaemons(db);

  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);
  const [requirementRows, daemonRows] = await Promise.all([
    db.query.requirements.findMany({
      where: and(not(inArray(requirements.status, ["done", "cancelled", "archived"])), scope?.requirement),
      with: {
        project: true,
        claim: true,
        dependencies: { with: { dependsOn: true } },
        executionSlices: {
          orderBy: (slice, { asc }) => [asc(slice.orderIndex), asc(slice.createdAt)],
        },
        tasks: {
          with: {
            dependencies: { with: { dependsOn: true } },
          },
          orderBy: (task, { asc }) => [asc(task.createdAt)],
        },
        repositories: { with: { repository: true } },
      },
      orderBy: (requirement, { asc }) => [
        asc(requirement.updatedAt),
        asc(requirement.id),
      ],
    }),
    db.query.daemons.findMany({
      where: and(
        scope?.daemon,
        gt(daemons.lastHeartbeatAt, oneMinuteAgo),
        not(eq(daemons.status, "offline")),
        eq(daemons.controlState, "running"),
      ),
    }),
  ]);

  const queueDaemons: DaemonQueueDaemonInput[] = daemonRows.map((daemon) => ({
    role: daemon.role,
    capabilities: daemon.capabilities ?? [],
  }));
  const items = requirementRows
    .map((requirement): DaemonQueueItem | null => classifyDaemonQueueRequirement({
      id: requirement.id,
      projectId: requirement.projectId,
      projectName: requirement.project.name,
      title: requirement.title,
      status: requirement.status,
      priority: requirement.priority,
      tags: requirement.tags,
      updatedAt: requirement.updatedAt,
      claim: requirement.claim
        ? {
            claimedBy: requirement.claim.claimedBy,
            expiresAt: requirement.claim.expiresAt,
            generation: requirement.claim.generation,
          }
        : null,
      dependencies: requirement.dependencies.map((dependency) => ({
        type: dependency.type,
        dependsOn: dependency.dependsOn
          ? {
              title: dependency.dependsOn.title,
              status: dependency.dependsOn.status,
            }
          : null,
      })),
      executionSlices: requirement.executionSlices.map((slice) => ({
        id: slice.id,
        title: slice.title,
        orderIndex: slice.orderIndex,
        allowParallel: slice.allowParallel,
        status: slice.status,
      })),
      tasks: requirement.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        tags: task.tags,
        executionSliceId: task.executionSliceId,
        dependencies: task.dependencies.map((dependency) => ({
          type: dependency.type,
          dependsOn: dependency.dependsOn
            ? {
                title: dependency.dependsOn.title,
                status: dependency.dependsOn.status,
              }
            : null,
        })),
      })),
      repositories: requirement.repositories.map((repository) => ({
        id: repository.id,
        repositoryId: repository.repositoryId,
        repositoryName: repository.repository.displayName,
        repositoryKey: repository.repository.canonicalKey,
        deliveryStatus: repository.deliveryStatus,
        failureCode: repository.failureCode,
        failureSummary: repository.failureSummary,
        retryCount: repository.retryCount,
        retryRole: repository.retryRole,
        retryPolicy: repository.retryPolicy,
        retryPhase: repository.retryPhase,
        nextAttemptAt: repository.nextAttemptAt,
        mergeMode: repository.mergeMode,
        manualActionUrl: repository.manualActionUrl,
      })),
    } satisfies DaemonQueueRequirementInput, queueDaemons, now))
    .filter((item): item is DaemonQueueItem => item !== null);

  return {
    generatedAt: now,
    items,
  };
}

async function enrichDaemonWorkerStates(db: Database, daemon: any) {
  const workerStates: DaemonWorkerState[] = Array.isArray(daemon.activeWorkerStates)
    ? [...daemon.activeWorkerStates] as DaemonWorkerState[]
    : [];
  const progressRows = await db.query.daemonWorkerProgress.findMany({
    where: eq(daemonWorkerProgress.daemonId, daemon.id),
  });
  if (daemon.status === "busy") {
    const knownWorkers = new Set(workerStates.map((worker) => worker.index));
    for (const progress of progressRows) {
      if (knownWorkers.has(progress.workerIndex)) continue;
      workerStates.push({
        index: progress.workerIndex,
        status: "running",
        requirementId: progress.requirementId,
        executionSliceId: progress.executionSliceId,
        taskId: progress.currentTaskId,
        runId: progress.runId,
        leaseGeneration: progress.leaseGeneration,
        progressPhase: progress.phase as DaemonWorkerState["progressPhase"],
        progressVersion: progress.version,
      });
    }
  }

  const enrichedWorkers = [];
  for (const worker of workerStates) {
    const storedProgress = progressRows.find((progress) => progress.workerIndex === worker.index);
    const progress = storedProgress
      && storedProgress.requirementId === worker.requirementId
      && (!worker.runId || storedProgress.runId === worker.runId)
      ? storedProgress
      : null;
    const requirementId = progress?.requirementId ?? worker.requirementId;
    const executionSliceId = progress?.executionSliceId ?? worker.executionSliceId;
    const currentTaskId = progress?.currentTaskId ?? worker.taskId;
    const requirement = requirementId
      ? await db.query.requirements.findFirst({
          where: (r, { eq }) => eq(r.id, requirementId),
          with: {
            tasks: {
              orderBy: (t, { asc }) => [asc(t.createdAt)],
            },
          },
        })
      : null;
    const claim = requirementId
      ? await db.query.requirementClaims.findFirst({
          where: eq(requirementClaims.requirementId, requirementId),
        })
      : null;
    const executionSlice = executionSliceId
      ? await db.query.executionSlices.findFirst({
          where: eq(executionSlices.id, executionSliceId),
          with: {
            tasks: {
              orderBy: (t, { asc }) => [asc(t.createdAt)],
            },
          },
        })
      : null;
    const currentTask = currentTaskId
      ? await db.query.tasks.findFirst({
          where: eq(tasks.id, currentTaskId),
        })
      : null;

    enrichedWorkers.push({
      ...worker,
      requirementId,
      executionSliceId,
      taskId: currentTaskId,
      taskTitle: currentTask?.title ?? worker.taskTitle ?? null,
      runId: progress?.runId ?? worker.runId ?? null,
      progressPhase: progress?.phase ?? worker.progressPhase ?? null,
      progressVersion: progress?.version ?? worker.progressVersion ?? null,
      progress: progress
        ? {
            phase: progress.phase,
            message: progress.message,
            workspaceState: progress.workspaceState,
            recoveryDisposition: progress.recoveryDisposition,
            retryCount: progress.retryCount,
            lastCompletedTaskId: progress.lastCompletedTaskId,
            pendingDiffSummary: progress.pendingDiffSummary,
            sliceSummary: progress.sliceSummary,
            handoffSummary: progress.handoffSummary,
            lastEventAt: progress.lastEventAt,
            version: progress.version,
          }
        : null,
      requirement: requirement
        ? {
            id: requirement.id,
            title: requirement.title,
            status: requirement.status,
            modelTier: requirement.modelTier,
            branchName: requirement.branchName,
          }
        : null,
      executionSlice,
      roadmap: executionSlice?.tasks ?? requirement?.tasks ?? [],
      claim: claim
        ? {
            expiresAt: claim.expiresAt,
            heartbeatAt: claim.heartbeatAt,
            claimedBy: claim.claimedBy,
            generation: claim.generation,
          }
        : null,
    });
  }

  return {
    ...daemonView(daemon),
    workerStates: enrichedWorkers,
  };
}

export async function applyTask(
  db: Database,
  daemonId: string,
  projectId?: string,
  caller?: Actor,
  authorizationFilter?: SQL,
) {
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, daemonId),
  });

  if (!daemon) {
    throw new NotFoundError("Daemon not found");
  }
  if (caller) assertDaemonActor(daemon, caller);
  assertDaemonRole(daemon, "executor");
  if (!daemonAcceptsWork(daemon)) return null;
  const actor = daemonActor(daemon);


  const projectFilter = projectId
    ? sql`AND t.project_id = ${projectId}`
    : sql``;

  const candidates = await db.execute(sql`
    SELECT t.* FROM tasks t
    WHERE t.status = 'todo'
      AND ${authorizationFilter ?? sql`false`}
      ${projectFilter}
      AND EXISTS (
        SELECT 1 FROM requirements r
        WHERE r.id = t.requirement_id
          AND r.status IN (${EXECUTOR_REQUIREMENT_STATUSES_SQL})
      )
      AND (
        (
          t.execution_slice_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM execution_slices current_slice
            WHERE current_slice.id = t.execution_slice_id
              AND current_slice.status NOT IN ('done', 'cancelled')
              AND (
                current_slice.allow_parallel = true
                OR NOT EXISTS (
                  SELECT 1 FROM execution_slices earlier_slice
                  WHERE earlier_slice.requirement_id = current_slice.requirement_id
                    AND earlier_slice.order_index < current_slice.order_index
                    AND earlier_slice.status NOT IN ('done', 'cancelled')
                )
              )
          )
        )
        OR (
          t.execution_slice_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM execution_slices planned_slice
            WHERE planned_slice.requirement_id = t.requirement_id
              AND planned_slice.status NOT IN ('done', 'cancelled')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = t.requirement_id
          AND rr.delivery_status = 'failed'
          AND (
            rr.retry_role IS DISTINCT FROM 'executor'
            OR rr.retry_policy IS NULL
            OR rr.retry_policy = 'manual'
            OR (
              rr.retry_policy = 'automatic'
              AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at > now())
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_claims rc
        WHERE rc.requirement_id = t.requirement_id AND rc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_claims tc
        WHERE tc.task_id = t.id AND tc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks blocker ON blocker.id = td.depends_on_task_id
        WHERE td.task_id = t.id
          AND td.type = 'blocks'
          AND blocker.status != 'done'
      )
    ORDER BY
      GREATEST(
        0,
        CASE t.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END - LEAST(3, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400)::int))
      ),
      t.created_at ASC,
      t.id ASC
    LIMIT ${ACQUISITION_CANDIDATE_LIMIT}
  `);

  const rows = candidates as unknown as Record<string, unknown>[];

  for (const row of rows) {
    const match = matchDaemonTaskCapabilities(
      (row.tags ?? []) as string[],
      daemon.capabilities ?? [],
    );
    if (!match.eligible) continue;

    const taskId = row.id as string;

    try {
      await claimTask(db, taskId, actor, 2);

      // Move the task out of 'todo' immediately so that, even if the claim lapses
      // (e.g. the executing agent is slow to renew), applyTask — which only selects
      // 'todo' tasks — cannot re-pick it and cause duplicate execution.
      // Dependency-blocked tasks were already excluded by the candidate query, so force the transition.
      try {
        await updateTaskStatus(db, taskId, "in_progress", actor, "Picked up by daemon", true);
      } catch (err) {
        if (!(err instanceof ValidationError)) {
          console.warn(`Failed to mark task ${taskId} as in_progress on pickup:`, err);
        }
        await releaseTask(
          db,
          taskId,
          actor,
          "Task activation failed during daemon acquisition",
        ).catch(() => undefined);
        continue;
      }

      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });

      return { task };
    } catch (err) {
      if (err instanceof ValidationError) continue;
      throw err;
    }
  }

  return null;
}

function eligibilityFlag(row: Record<string, unknown>, key: string) {
  return row[key] === true || row[key] === "t" || row[key] === 1;
}

export async function explainRequirementEligibility(
  db: Database,
  daemonId: string,
  projectId?: string,
  modelTiers?: ("fast" | "standard" | "strong")[],
  caller?: Actor,
  authorizationFilter?: SQL,
): Promise<SchedulerEligibilityDiagnostics> {
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, daemonId),
  });
  if (!daemon) throw new NotFoundError("Daemon not found");
  if (caller) assertDaemonActor(daemon, caller);
  assertDaemonRole(daemon, "executor");

  const projectFilter = projectId ? sql`AND t.project_id = ${projectId}` : sql``;
  const modelTierBlocked = modelTiers && modelTiers.length > 0
    ? sql`COALESCE(es.model_tier, r.model_tier)::text NOT IN (${sql.join(modelTiers.map((tier) => sql`${tier}`), sql`, `)})`
    : sql`false`;

  const candidates = await db.execute(sql`
    SELECT
      t.id AS task_id,
      t.tags AS task_tags,
      r.id AS requirement_id,
      COUNT(*) OVER() AS candidate_count,
      (r.status NOT IN (${EXECUTOR_REQUIREMENT_STATUSES_SQL})) AS blocked_status,
      (
        EXISTS (
          SELECT 1 FROM requirement_dependencies rd
          JOIN requirements blocker_req ON blocker_req.id = rd.depends_on_requirement_id
          WHERE rd.requirement_id = r.id
            AND rd.type = 'blocks'
            AND blocker_req.status NOT IN ('done', 'cancelled')
        )
        OR EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks blocker ON blocker.id = td.depends_on_task_id
          WHERE td.task_id = t.id
            AND td.type = 'blocks'
            AND blocker.status != 'done'
        )
      ) AS blocked_dependency,
      (
        EXISTS (
          SELECT 1 FROM requirement_claims rc
          WHERE rc.requirement_id = r.id AND rc.expires_at > now()
        )
        OR EXISTS (
          SELECT 1 FROM task_claims tc
          WHERE tc.task_id = t.id AND tc.expires_at > now()
        )
      ) AS blocked_claim,
      CASE
        WHEN es.id IS NULL THEN EXISTS (
          SELECT 1 FROM execution_slices planned_slice
          WHERE planned_slice.requirement_id = r.id
            AND planned_slice.status NOT IN ('done', 'cancelled')
        )
        WHEN es.status IN ('done', 'cancelled') THEN true
        WHEN es.allow_parallel = true THEN false
        ELSE EXISTS (
          SELECT 1 FROM execution_slices earlier_slice
          WHERE earlier_slice.requirement_id = r.id
            AND earlier_slice.order_index < es.order_index
            AND earlier_slice.status NOT IN ('done', 'cancelled')
        )
      END AS blocked_slice_order,
      (${modelTierBlocked}) AS blocked_model_tier,
      EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = r.id
          AND rr.delivery_status = 'failed'
          AND rr.retry_role = 'executor'
          AND rr.retry_policy = 'automatic'
          AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at > now())
      ) AS blocked_retry_time,
      EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = r.id
          AND rr.delivery_status = 'failed'
          AND (
            rr.retry_role IS DISTINCT FROM 'executor'
            OR rr.retry_policy IS NULL
            OR rr.retry_policy = 'manual'
          )
      ) AS blocked_policy
    FROM tasks t
    JOIN requirements r ON r.id = t.requirement_id
    LEFT JOIN execution_slices es ON es.id = t.execution_slice_id
    WHERE t.status = 'todo'
      ${projectFilter}
      AND ${authorizationFilter ?? sql`false`}
    ORDER BY
      GREATEST(
        0,
        CASE r.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END - LEAST(3, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - r.created_at)) / 86400)::int))
      ),
      GREATEST(
        0,
        CASE t.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END - LEAST(3, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400)::int))
      ),
      t.created_at ASC,
      r.id ASC,
      t.id ASC
    LIMIT ${ELIGIBILITY_CANDIDATE_LIMIT}
  `);

  const rows = candidates as unknown as Record<string, unknown>[];
  const skipCounts = Object.fromEntries(
    ELIGIBILITY_REASONS.map((reason) => [reason, 0]),
  ) as Record<SchedulerEligibilityReason, number>;
  const samples: SchedulerEligibilityDiagnostics["samples"] = [];
  let runnableCount = 0;

  for (const row of rows) {
    const reasons: SchedulerEligibilityReason[] = [];
    if (eligibilityFlag(row, "blocked_status")) reasons.push("status");
    if (eligibilityFlag(row, "blocked_dependency")) reasons.push("dependency");
    if (eligibilityFlag(row, "blocked_claim")) reasons.push("claim");
    if (eligibilityFlag(row, "blocked_slice_order")) reasons.push("slice_order");
    if (!matchDaemonTaskCapabilities(
      (row.task_tags ?? []) as string[],
      daemon.capabilities ?? [],
    ).eligible) reasons.push("capability");
    if (eligibilityFlag(row, "blocked_model_tier")) reasons.push("model_tier");
    if (eligibilityFlag(row, "blocked_retry_time")) reasons.push("retry_time");
    if (eligibilityFlag(row, "blocked_policy")) reasons.push("policy");

    if (reasons.length === 0) {
      runnableCount += 1;
      continue;
    }
    for (const reason of reasons) skipCounts[reason] += 1;
    if (samples.length < ELIGIBILITY_SAMPLE_LIMIT) {
      samples.push({
        requirementId: String(row.requirement_id),
        taskId: String(row.task_id),
        reasons,
      });
    }
  }

  const candidateCount = rows.length > 0
    ? Number(rows[0]!.candidate_count ?? rows.length)
    : 0;
  return {
    candidateCount,
    examinedCount: rows.length,
    runnableCount,
    selectedCount: 0,
    truncated: candidateCount > rows.length,
    skipCounts,
    samples,
  };
}

export async function applyRequirement(
  db: Database,
  daemonId: string,
  projectId?: string,
  workerIndex?: number,
  modelTiers?: ("fast" | "standard" | "strong")[],
  caller?: Actor,
  authorizationFilter?: SQL,
) {
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, daemonId),
  });

  if (!daemon) {
    throw new NotFoundError("Daemon not found");
  }
  if (caller) assertDaemonActor(daemon, caller);
  assertDaemonRole(daemon, "executor");
  if (!daemonAcceptsWork(daemon)) return null;
  const actor = daemonActor(daemon);


  const projectFilter = projectId
    ? sql`AND t.project_id = ${projectId}`
    : sql``;
  const tierFilter = modelTiers && modelTiers.length > 0
    ? sql`AND COALESCE(es.model_tier, r.model_tier)::text IN (${sql.join(modelTiers.map((tier) => sql`${tier}`), sql`, `)})`
    : sql``;

  const candidates = await db.execute(sql`
    SELECT
      t.*,
      r.title AS requirement_title,
      r.description AS requirement_description,
      r.status AS requirement_status,
      r.priority AS requirement_priority,
      r.model_tier AS requirement_model_tier,
      r.branch_name AS requirement_branch_name,
      es.id AS execution_slice_id,
      es.title AS execution_slice_title,
      es.description AS execution_slice_description,
      es.order_index AS execution_slice_order_index,
      es.model_tier AS execution_slice_model_tier,
      es.status AS execution_slice_status
    FROM tasks t
    JOIN requirements r ON r.id = t.requirement_id
    LEFT JOIN execution_slices es ON es.id = t.execution_slice_id
    WHERE t.status = 'todo'
      AND ${authorizationFilter ?? sql`false`}
      ${projectFilter}
      ${tierFilter}
      AND r.status IN (${EXECUTOR_REQUIREMENT_STATUSES_SQL})
      AND NOT EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = r.id
          AND rr.delivery_status = 'failed'
          AND (
            rr.retry_role IS DISTINCT FROM 'executor'
            OR rr.retry_policy IS NULL
            OR rr.retry_policy = 'manual'
            OR (
              rr.retry_policy = 'automatic'
              AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at > now())
            )
          )
      )
      AND (es.id IS NULL OR es.status NOT IN ('done', 'cancelled'))
      AND (
        (
          es.id IS NOT NULL
          AND (
            es.allow_parallel = true
            OR NOT EXISTS (
              SELECT 1 FROM execution_slices earlier_slice
              WHERE earlier_slice.requirement_id = r.id
                AND earlier_slice.order_index < es.order_index
                AND earlier_slice.status NOT IN ('done', 'cancelled')
            )
          )
        )
        OR (
          es.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM execution_slices planned_slice
            WHERE planned_slice.requirement_id = r.id
              AND planned_slice.status NOT IN ('done', 'cancelled')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_dependencies rd
        JOIN requirements blocker_req ON blocker_req.id = rd.depends_on_requirement_id
        WHERE rd.requirement_id = r.id
          AND rd.type = 'blocks'
          AND blocker_req.status NOT IN ('done', 'cancelled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_claims rc
        WHERE rc.requirement_id = r.id AND rc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_claims tc
        WHERE tc.task_id = t.id AND tc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks blocker ON blocker.id = td.depends_on_task_id
        WHERE td.task_id = t.id
          AND td.type = 'blocks'
          AND blocker.status != 'done'
      )
    ORDER BY
      GREATEST(
        0,
        CASE r.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END - LEAST(3, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - r.created_at)) / 86400)::int))
      ),
      GREATEST(
        0,
        CASE t.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END - LEAST(3, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400)::int))
      ),
      es.order_index ASC NULLS LAST,
      t.created_at ASC,
      r.id ASC,
      t.id ASC
    LIMIT ${ACQUISITION_CANDIDATE_LIMIT}
  `);

  const rows = candidates as unknown as Record<string, unknown>[];

  for (const row of rows) {
    const match = matchDaemonTaskCapabilities(
      (row.tags ?? []) as string[],
      daemon.capabilities ?? [],
    );
    if (!match.eligible) continue;

    const requirementId = row.requirement_id as string;
    const taskId = row.id as string;
    const executionSliceId = row.execution_slice_id as string | null;

    try {
      const claim = await claimRequirement(
        db,
        requirementId,
        actor,
        2,
        { daemonId, workerIndex },
      );

      try {
        await updateTaskStatus(
          db,
          taskId,
          "in_progress",
          actor,
          "Picked up by daemon requirement lane",
          true,
          { daemonId, leaseGeneration: claim.generation },
        );
      } catch (err) {
        if (!(err instanceof ValidationError)) {
          console.warn(`Failed to mark task ${taskId} as in_progress on requirement pickup:`, err);
        }
        await releaseRequirement(
          db,
          requirementId,
          actor,
          "Task activation failed during daemon acquisition",
          daemonId,
          claim.generation,
        ).catch(() => undefined);
        continue;
      }
      if (executionSliceId) {
        await db
          .update(executionSlices)
          .set({ status: "in_progress", updatedAt: new Date() })
          .where(eq(executionSlices.id, executionSliceId));
      }

      const requirement = await db.query.requirements.findFirst({
        where: (r, { eq }) => eq(r.id, requirementId),
        with: {
          executionSlices: {
            with: { tasks: true },
            orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
          },
          tasks: {
            orderBy: (t, { asc }) => [asc(t.createdAt)],
          },
          repositories: {
            with: { repository: true },
          },
        },
      });

      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      const executionSlice = executionSliceId
        ? await db.query.executionSlices.findFirst({
            where: eq(executionSlices.id, executionSliceId),
            with: {
              tasks: {
                orderBy: (t, { asc }) => [asc(t.createdAt)],
              },
            },
          })
        : null;

      return {
        requirement,
        task,
        executionSlice,
        tasks: executionSlice?.tasks ?? requirement?.tasks ?? [],
        repositories: requirement?.repositories ?? [],
        executorTool: match.executorTool,
        leaseGeneration: claim.generation,
        runId: claim.id,
      };
    } catch (err) {
      if (err instanceof ValidationError) continue;
      throw err;
    }
  }

  return null;
}

export async function applyReview(
  db: Database,
  daemonId: string,
  projectId?: string,
  workerIndex?: number,
  caller?: Actor,
  authorizationFilter?: SQL,
) {
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, daemonId),
  });

  if (!daemon) {
    throw new NotFoundError("Daemon not found");
  }
  if (caller) assertDaemonActor(daemon, caller);
  assertDaemonRole(daemon, "reviewer");
  if (!daemonAcceptsWork(daemon)) return null;
  const actor = daemonActor(daemon);


  const projectFilter = projectId
    ? sql`AND r.project_id = ${projectId}`
    : sql``;

  const candidates = await db.execute(sql`
    SELECT r.*
    FROM requirements r
    WHERE ${authorizationFilter ?? sql`false`} AND r.status = ${REVIEWER_REQUIREMENT_STATUS_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = r.id
          AND rr.delivery_status = 'failed'
          AND (
            rr.retry_role IS DISTINCT FROM 'reviewer'
            OR rr.retry_policy IS NULL
            OR rr.retry_policy = 'manual'
            OR (
              rr.retry_policy = 'automatic'
              AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at > now())
            )
          )
      )
      ${projectFilter}
      AND NOT EXISTS (
        SELECT 1 FROM requirement_claims rc
        WHERE rc.requirement_id = r.id AND rc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_dependencies rd
        JOIN requirements blocker_req ON blocker_req.id = rd.depends_on_requirement_id
        WHERE rd.requirement_id = r.id
          AND rd.type = 'blocks'
          AND blocker_req.status NOT IN ('done', 'cancelled')
      )
    ORDER BY
      CASE r.priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
      END,
      r.updated_at ASC
    LIMIT 25
  `);

  const rows = candidates as unknown as Record<string, unknown>[];

  for (const row of rows) {
    const requirementTags = (row.tags ?? []) as string[];
    const requiredTools = requirementTags
      .filter((tag) => tag.startsWith("tool:"))
      .map((tag) => tag.slice(5));

    if (requiredTools.length > 0) {
      const daemonCaps = daemon.capabilities || [];
      const hasMatch = requiredTools.some((tool) => daemonCaps.includes(tool));
      if (!hasMatch) continue;
    }

    const requirementId = row.id as string;

    try {
      const claim = await claimRequirement(
        db,
        requirementId,
        actor,
        5,
        { daemonId, workerIndex },
      );

      const requirement = await db.query.requirements.findFirst({
        where: eq(requirements.id, requirementId),
        with: {
          tasks: {
            orderBy: (t, { asc }) => [asc(t.createdAt)],
          },
          executionSlices: {
            orderBy: (s, { desc }) => [desc(s.orderIndex), desc(s.createdAt)],
          },
          repositories: { with: { repository: true } },
        },
      });

      return {
        requirement,
        tasks: requirement?.tasks ?? [],
        executionSlice: requirement?.executionSlices?.[0] ?? null,
        repositories: requirement?.repositories ?? [],
        leaseGeneration: claim.generation,
        runId: claim.id,
      };
    } catch (err) {
      if (err instanceof ValidationError) continue;
      throw err;
    }
  }

  return null;
}

export async function applyMerge(
  db: Database,
  daemonId: string,
  projectId?: string,
  workerIndex?: number,
  caller?: Actor,
  authorizationFilter?: SQL,
) {
  const daemon = await db.query.daemons.findFirst({
    where: eq(daemons.id, daemonId),
  });

  if (!daemon) {
    throw new NotFoundError("Daemon not found");
  }
  if (caller) assertDaemonActor(daemon, caller);
  assertDaemonRole(daemon, "merger");
  if (!daemonAcceptsWork(daemon)) return null;
  const actor = daemonActor(daemon);


  const projectFilter = projectId
    ? sql`AND r.project_id = ${projectId}`
    : sql``;

  const candidates = await db.execute(sql`
    SELECT r.*
    FROM requirements r
    WHERE ${authorizationFilter ?? sql`false`} AND r.status = ${MERGER_REQUIREMENT_STATUS_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM requirement_repositories manual_rr
        WHERE manual_rr.requirement_id = r.id
          AND manual_rr.delivery_status = 'ready_to_merge'
          AND manual_rr.merge_mode = 'manual'
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_repositories rr
        WHERE rr.requirement_id = r.id
          AND rr.delivery_status = 'failed'
          AND (
            rr.retry_role IS DISTINCT FROM 'merger'
            OR rr.retry_policy IS NULL
            OR rr.retry_policy = 'manual'
            OR (
              rr.retry_policy = 'automatic'
              AND (rr.next_attempt_at IS NULL OR rr.next_attempt_at > now())
            )
          )
      )
      ${projectFilter}
      AND NOT EXISTS (
        SELECT 1 FROM requirement_claims rc
        WHERE rc.requirement_id = r.id AND rc.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM requirement_dependencies rd
        JOIN requirements blocker_req ON blocker_req.id = rd.depends_on_requirement_id
        WHERE rd.requirement_id = r.id
          AND rd.type = 'blocks'
          AND blocker_req.status NOT IN ('done', 'cancelled')
      )
    ORDER BY
      CASE r.priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
      END,
      r.updated_at ASC
    LIMIT 25
  `);

  const rows = candidates as unknown as Record<string, unknown>[];

  for (const row of rows) {
    const requirementTags = (row.tags ?? []) as string[];
    const requiredTools = requirementTags
      .filter((tag) => tag.startsWith("tool:"))
      .map((tag) => tag.slice(5));

    if (requiredTools.length > 0) {
      const daemonCaps = daemon.capabilities || [];
      const hasMatch = requiredTools.some((tool) => daemonCaps.includes(tool));
      if (!hasMatch) continue;
    }

    const requirementId = row.id as string;

    try {
      const claim = await claimRequirement(
        db,
        requirementId,
        actor,
        5,
        { daemonId, workerIndex },
      );

      const requirement = await db.query.requirements.findFirst({
        where: eq(requirements.id, requirementId),
        with: {
          tasks: {
            orderBy: (t, { asc }) => [asc(t.createdAt)],
          },
          executionSlices: {
            orderBy: (s, { desc }) => [desc(s.orderIndex), desc(s.createdAt)],
          },
          repositories: { with: { repository: true } },
        },
      });

      return {
        requirement,
        tasks: requirement?.tasks ?? [],
        executionSlice: requirement?.executionSlices?.[0] ?? null,
        repositories: requirement?.repositories ?? [],
        leaseGeneration: claim.generation,
        runId: claim.id,
      };
    } catch (err) {
      if (err instanceof ValidationError) continue;
      throw err;
    }
  }

  return null;
}
