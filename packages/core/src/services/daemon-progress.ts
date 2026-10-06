import type { MetadataReadScope } from "./metadata-read-scope";
import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  activityLog,
  daemonWorkerProgress,
  daemonWorkerProgressHistory,
  daemons,
  type Database,
  executionSlices,
  requirements,
  tasks,
  taskStatusLog,
} from "@task-weaver/db";
import { emit } from "@task-weaver/realtime";
import { NotFoundError, ValidationError } from "@task-weaver/contracts";
import type { Actor } from "@task-weaver/contracts";
import type {
  DaemonProgressPhase,
  DaemonProgressSource,
  DaemonRecoveryDisposition,
  DaemonRole,
  DaemonWorkspaceState,
  DaemonHistoryKind,
  DaemonHistoryQuery,
  ReconcileDaemonWorkerInput,
  ReportDaemonProgressInput,
} from "@task-weaver/contracts";
import {
  isProgressTransitionValid,
  redactObservabilityAttributes,
  redactObservabilityText,
} from "@task-weaver/contracts";
import type { TaskStatus } from "@task-weaver/contracts";
import { assertRequirementLease } from "./claims";
import { buildDaemonTimeline } from "./daemon-timeline";

interface ProgressWrite {
  eventId?: string;
  daemonId: string;
  runId: string;
  workerIndex: number;
  role: DaemonRole;
  projectId?: string | null;
  requirementId: string;
  executionSliceId: string | null;
  currentTaskId: string | null;
  phase: DaemonProgressPhase;
  message: string | null;
  workspaceState?: DaemonWorkspaceState;
  recoveryDisposition?: DaemonRecoveryDisposition;
  retryCount?: number;
  lastCompletedTaskId?: string | null;
  pendingDiffSummary?: string | null;
  sliceSummary?: string | null;
  handoffSummary?: string | null;
  source: DaemonProgressSource;
  severity?: "debug" | "info" | "warn" | "error";
  sequence?: number;
  leaseGeneration: number;
  details: Record<string, unknown>;
}

type ProgressDatabase = Pick<Database, "query" | "insert" | "update">;

function assertDaemonOwner(
  daemon: { id: string; actorId?: string | null },
  actor: Actor,
) {
  if (actor.id !== daemon.id && actor.id !== daemon.actorId) {
    throw new ValidationError(`Daemon instance '${daemon.id}' does not belong to actor '${actor.id}'`);
  }
}

async function validateProgressTargets(db: Database, input: ProgressWrite) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, input.requirementId),
  });
  if (!requirement) throw new NotFoundError("Requirement not found");

  if (input.executionSliceId) {
    const slice = await db.query.executionSlices.findFirst({
      where: eq(executionSlices.id, input.executionSliceId),
    });
    if (!slice) throw new NotFoundError("Execution slice not found");
    if (slice.requirementId !== input.requirementId) {
      throw new ValidationError("Progress execution slice must belong to the active Requirement");
    }
  }

  if (input.currentTaskId) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, input.currentTaskId),
    });
    if (!task) throw new NotFoundError("Progress task not found");
    if (task.requirementId !== input.requirementId) {
      throw new ValidationError("Progress task must belong to the active Requirement");
    }
    if (input.executionSliceId && task.executionSliceId !== input.executionSliceId) {
      throw new ValidationError("Progress task must belong to the active execution slice");
    }
  }
  return requirement;
}

async function persistWorkerProgress(db: ProgressDatabase, input: ProgressWrite) {
  const eventId = input.eventId ?? randomUUID();
  if (input.eventId) {
    const duplicate = await db.query.daemonWorkerProgressHistory.findFirst({
      where: eq(daemonWorkerProgressHistory.id, input.eventId),
    });
    if (duplicate) {
      const current = await db.query.daemonWorkerProgress.findFirst({
        where: and(
          eq(daemonWorkerProgress.daemonId, input.daemonId),
          eq(daemonWorkerProgress.workerIndex, input.workerIndex),
        ),
      });
      return current ?? duplicate;
    }
  }
  const current = await db.query.daemonWorkerProgress.findFirst({
    where: and(
      eq(daemonWorkerProgress.daemonId, input.daemonId),
      eq(daemonWorkerProgress.workerIndex, input.workerIndex),
    ),
  });
  const now = new Date();
  const version = (current?.version ?? 0) + 1;
  const startedAt = current?.runId === input.runId ? current.startedAt : now;
  const workspaceState = input.workspaceState ?? current?.workspaceState ?? "unknown";
  const recoveryDisposition = input.recoveryDisposition ?? current?.recoveryDisposition ?? "none";
  const retryCount = input.retryCount ?? current?.retryCount ?? 0;
  const lastCompletedTaskId = input.lastCompletedTaskId !== undefined
    ? input.lastCompletedTaskId
    : current?.lastCompletedTaskId ?? null;
  const pendingDiffSummary = input.pendingDiffSummary !== undefined
    ? input.pendingDiffSummary
    : current?.pendingDiffSummary ?? null;
  const sliceSummary = input.sliceSummary !== undefined
    ? input.sliceSummary
    : current?.sliceSummary ?? null;
  const handoffSummary = input.handoffSummary !== undefined
    ? input.handoffSummary
    : current?.handoffSummary ?? null;
  const sanitizedMessage = input.message === null || input.message === undefined
    ? null
    : redactObservabilityText(input.message, 2_000).value;
  const sanitizedPendingDiff = pendingDiffSummary === null || pendingDiffSummary === undefined
    ? null
    : redactObservabilityText(pendingDiffSummary, 10_000).value;
  const sanitizedSliceSummary = sliceSummary === null || sliceSummary === undefined
    ? null
    : redactObservabilityText(sliceSummary, 10_000).value;
  const sanitizedHandoffSummary = handoffSummary === null || handoffSummary === undefined
    ? null
    : redactObservabilityText(handoffSummary, 10_000).value;
  const sanitizedDetails = redactObservabilityAttributes(input.details).value;
  const transitionIsValid = isProgressTransitionValid(current?.phase, input.phase);
  const details = transitionIsValid
    ? sanitizedDetails
    : {
        ...sanitizedDetails,
        reconciliation: {
          reason: "invalid_progress_transition",
          from: current?.phase ?? null,
          to: input.phase,
        },
      };

  const [updated] = await db.insert(daemonWorkerProgress).values({
    daemonId: input.daemonId,
    runId: input.runId,
    workerIndex: input.workerIndex,
    role: input.role,
    requirementId: input.requirementId,
    executionSliceId: input.executionSliceId,
    currentTaskId: input.currentTaskId,
    phase: input.phase,
    message: sanitizedMessage,
    workspaceState,
    recoveryDisposition,
    retryCount,
    lastCompletedTaskId,
    pendingDiffSummary: sanitizedPendingDiff,
    sliceSummary: sanitizedSliceSummary,
    handoffSummary: sanitizedHandoffSummary,
    leaseGeneration: input.leaseGeneration,
    version,
    startedAt,
    lastEventAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [daemonWorkerProgress.daemonId, daemonWorkerProgress.workerIndex],
    set: {
      runId: input.runId,
      role: input.role,
      requirementId: input.requirementId,
      executionSliceId: input.executionSliceId,
      currentTaskId: input.currentTaskId,
      phase: input.phase,
      message: sanitizedMessage,
      workspaceState,
      recoveryDisposition,
      retryCount,
      lastCompletedTaskId,
      pendingDiffSummary: sanitizedPendingDiff,
      sliceSummary: sanitizedSliceSummary,
      handoffSummary: sanitizedHandoffSummary,
      leaseGeneration: input.leaseGeneration,
      version,
      startedAt,
      lastEventAt: now,
      updatedAt: now,
    },
  }).returning();

  await db.insert(daemonWorkerProgressHistory).values({
    id: eventId,
    daemonId: input.daemonId,
    runId: input.runId,
    workerIndex: input.workerIndex,
    role: input.role,
    requirementId: input.requirementId,
    executionSliceId: input.executionSliceId,
    currentTaskId: input.currentTaskId,
    phase: input.phase,
    message: sanitizedMessage,
    workspaceState,
    recoveryDisposition,
    retryCount,
    lastCompletedTaskId,
    pendingDiffSummary: sanitizedPendingDiff,
    sliceSummary: sanitizedSliceSummary,
    handoffSummary: sanitizedHandoffSummary,
    source: input.source,
    leaseGeneration: input.leaseGeneration,
    version,
    details,
    occurredAt: now,
  });

  emit({
    type: "daemon_progress_updated",
    eventId,
    runId: input.runId,
    sequence: input.sequence ?? version,
    cursor: `${now.toISOString()}:${eventId}`,
    severity: input.severity ?? "info",
    source: input.source,
    attributes: details,
    projectId: input.projectId ?? null,
    daemonId: input.daemonId,
    workerIndex: input.workerIndex,
    requirementId: input.requirementId,
    executionSliceId: input.executionSliceId,
    currentTaskId: input.currentTaskId,
    phase: input.phase,
    message: sanitizedMessage,
    workspaceState,
    recoveryDisposition,
    retryCount,
    version,
    lastEventAt: now,
  });

  return updated!;
}

export async function reportWorkerProgress(
  db: Database,
  daemonId: string,
  input: ReportDaemonProgressInput,
  actor: Actor,
) {
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
  if (!daemon) throw new NotFoundError("Daemon not found");
  assertDaemonOwner(daemon, actor);

  const claim = await assertRequirementLease(
    db,
    input.requirementId,
    actor,
    { daemonId, leaseGeneration: input.leaseGeneration },
    true,
  );
  if (!claim) throw new ValidationError("Progress reporting requires an active Requirement claim");
  if (claim.id !== input.runId) {
    throw new ValidationError("Progress runId must match the active Requirement claim");
  }
  if (claim.workerIndex !== null && claim.workerIndex !== String(input.workerIndex)) {
    throw new ValidationError("Progress worker index must match the active Requirement claim");
  }

  const write: ProgressWrite = {
    eventId: input.eventId,
    daemonId,
    runId: input.runId,
    workerIndex: input.workerIndex,
    role: daemon.role ?? "executor",
    requirementId: input.requirementId,
    executionSliceId: input.executionSliceId ?? null,
    currentTaskId: input.currentTaskId ?? null,
    phase: input.phase,
    message: input.message ?? null,
    workspaceState: input.workspaceState,
    recoveryDisposition: input.recoveryDisposition,
    lastCompletedTaskId: input.lastCompletedTaskId,
    pendingDiffSummary: input.pendingDiffSummary,
    sliceSummary: input.sliceSummary,
    handoffSummary: input.handoffSummary,
    source: input.source,
    severity: input.severity,
    sequence: input.sequence,
    leaseGeneration: input.leaseGeneration,
    details: input.details,
  };
  const requirement = await validateProgressTargets(db, write);
  write.projectId = requirement.projectId;
  return persistWorkerProgress(db, write);
}

export async function listWorkerProgress(
  db: Database,
  input: {
    daemonId?: string;
    requirementId?: string;
    runId?: string;
    workerIndex?: number;
    limit: number;
  },
) {
  const conditions = [
    input.daemonId ? eq(daemonWorkerProgress.daemonId, input.daemonId) : undefined,
    input.requirementId ? eq(daemonWorkerProgress.requirementId, input.requirementId) : undefined,
    input.runId ? eq(daemonWorkerProgress.runId, input.runId) : undefined,
    input.workerIndex !== undefined
      ? eq(daemonWorkerProgress.workerIndex, input.workerIndex)
      : undefined,
  ].filter((condition) => condition !== undefined);
  return db.query.daemonWorkerProgress.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(daemonWorkerProgress.updatedAt),
    limit: input.limit,
  });
}

export async function listWorkerProgressHistory(
  db: Database,
  input: {
    daemonId?: string;
    requirementId?: string;
    runId?: string;
    workerIndex?: number;
    limit: number;
  },
) {
  const conditions = [
    input.daemonId ? eq(daemonWorkerProgressHistory.daemonId, input.daemonId) : undefined,
    input.requirementId
      ? eq(daemonWorkerProgressHistory.requirementId, input.requirementId)
      : undefined,
    input.runId ? eq(daemonWorkerProgressHistory.runId, input.runId) : undefined,
    input.workerIndex !== undefined
      ? eq(daemonWorkerProgressHistory.workerIndex, input.workerIndex)
      : undefined,
  ].filter((condition) => condition !== undefined);
  return db.query.daemonWorkerProgressHistory.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(daemonWorkerProgressHistory.occurredAt),
    limit: input.limit,
  });
}

interface HistoryCursor {
  occurredAt: string;
  id: string;
}

function encodeHistoryCursor(cursor: HistoryCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): HistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (typeof parsed.occurredAt !== "string" || typeof parsed.id !== "string") return null;
    const occurredAt = new Date(parsed.occurredAt);
    return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt: occurredAt.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function timelineEventSeverity(event: { kind: string; details?: Record<string, unknown> }) {
  const severity = event.details?.severity;
  return severity === "debug" || severity === "info" || severity === "warn" || severity === "error"
    ? severity
    : "info" as const;
}

function timelineEventMatchesKind(kind: DaemonHistoryKind | undefined, eventKind: string) {
  return !kind || kind === eventKind;
}

/**
 * Return a stable, bounded history stream across progress, task, activity,
 * and repository delivery records. Repository rows are explicitly marked as
 * snapshots so consumers never mistake current state for an immutable event.
 */
export async function listCorrelatedHistory(
  db: Database,
  input: DaemonHistoryQuery,
  scope?: MetadataReadScope,
) {
  const conditions = [
    scope?.history,
    input.daemonId ? eq(daemonWorkerProgressHistory.daemonId, input.daemonId) : undefined,
    input.requirementId ? eq(daemonWorkerProgressHistory.requirementId, input.requirementId) : undefined,
    input.runId ? eq(daemonWorkerProgressHistory.runId, input.runId) : undefined,
    input.workerIndex !== undefined ? eq(daemonWorkerProgressHistory.workerIndex, input.workerIndex) : undefined,
    input.since ? gte(daemonWorkerProgressHistory.occurredAt, new Date(input.since)) : undefined,
    input.until ? lte(daemonWorkerProgressHistory.occurredAt, new Date(input.until)) : undefined,
  ].filter((condition) => condition !== undefined);
  const progress = await db.query.daemonWorkerProgressHistory.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(daemonWorkerProgressHistory.occurredAt), desc(daemonWorkerProgressHistory.id)],
    limit: Math.min(400, input.limit * 3),
  });

  const requirement = input.requirementId
    ? await db.query.requirements.findFirst({
        where: and(eq(requirements.id, input.requirementId), scope?.requirement),
        with: {
          tasks: { orderBy: (task, { asc }) => [asc(task.createdAt)] },
          executionSlices: true,
          repositories: { with: { repository: true } },
        },
      })
    : null;
  const taskIds = requirement?.tasks.map((task) => task.id) ?? [];
  const activityCondition = requirement && taskIds.length > 0
    ? or(
        and(eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, requirement.id)),
        and(eq(activityLog.entityType, "task"), inArray(activityLog.entityId, taskIds)),
      )
    : requirement
      ? and(eq(activityLog.entityType, "requirement"), eq(activityLog.entityId, requirement.id))
      : !scope && input.daemonId
        ? and(eq(activityLog.entityType, "daemon"), eq(activityLog.entityId, input.daemonId))
        : undefined;
  const [taskStatuses, activities] = await Promise.all([
    taskIds.length > 0
      ? db.query.taskStatusLog.findMany({
          where: input.since || input.until
            ? and(
                inArray(taskStatusLog.taskId, taskIds),
                ...(input.since ? [gte(taskStatusLog.createdAt, new Date(input.since))] : []),
                ...(input.until ? [lte(taskStatusLog.createdAt, new Date(input.until))] : []),
              )
            : inArray(taskStatusLog.taskId, taskIds),
          orderBy: [desc(taskStatusLog.createdAt), desc(taskStatusLog.id)],
          limit: Math.min(400, input.limit * 3),
        })
      : Promise.resolve([]),
    activityCondition
      ? db.query.activityLog.findMany({
          where: activityCondition,
          orderBy: [desc(activityLog.createdAt), desc(activityLog.id)],
          limit: Math.min(400, input.limit * 3),
        })
      : Promise.resolve([]),
  ]);

  const timeline = buildDaemonTimeline({
    progress,
    taskStatuses,
    activities,
    repositories: requirement?.repositories.map((entry) => ({
      id: entry.id,
      repositoryId: entry.repositoryId,
      repositoryName: entry.repository.displayName,
      deliveryStatus: entry.deliveryStatus,
      pushStatus: entry.pushStatus,
      reviewStatus: entry.reviewStatus,
      mergeStatus: entry.mergeStatus,
      failureCode: entry.failureCode,
      failureSummary: entry.failureSummary,
      retryCount: entry.retryCount,
      retryPhase: entry.retryPhase,
      retryRole: entry.retryRole,
      retryPolicy: entry.retryPolicy,
      resumeOperation: entry.resumeOperation,
      nextAttemptAt: entry.nextAttemptAt,
      pullRequestUrl: entry.pullRequestUrl,
      headCommit: entry.headCommit,
      pushedCommit: entry.pushedCommit,
      mergeMode: entry.mergeMode,
      manualActionUrl: entry.manualActionUrl,
      externalSyncRevision: entry.externalSyncRevision,
      externalStateUpdatedAt: entry.externalStateUpdatedAt,
      updatedAt: entry.updatedAt,
    })) ?? [],
    taskTitles: Object.fromEntries((requirement?.tasks ?? []).map((task) => [task.id, task.title])),
    sliceTitles: Object.fromEntries((requirement?.executionSlices ?? []).map((slice) => [slice.id, slice.title])),
    repositoryNames: Object.fromEntries((requirement?.repositories ?? []).map((entry) => [entry.repositoryId, entry.repository.displayName])),
    limit: Math.min(400, input.limit * 3),
  });
  const cursor = decodeHistoryCursor(input.cursor);
  const filtered = timeline
    .filter((event) => timelineEventMatchesKind(input.kind, event.kind))
    .filter((event) => !input.severity || timelineEventSeverity(event) === input.severity)
    .filter((event) => {
      if (!cursor) return true;
      const eventTime = new Date(event.occurredAt).getTime();
      const cursorTime = new Date(cursor.occurredAt).getTime();
      return eventTime < cursorTime || (eventTime === cursorTime && event.id < cursor.id);
    })
    .sort((left, right) => {
      const timeDifference = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
      return timeDifference || right.id.localeCompare(left.id);
    });
  const page = filtered.slice(0, input.limit + 1);
  const hasMore = page.length > input.limit;
  const items = page.slice(0, input.limit).map((event) => ({
    ...event,
    eventId: event.id,
    severity: timelineEventSeverity(event),
    isSnapshot: event.id.startsWith("repository:"),
    cursor: encodeHistoryCursor({ occurredAt: new Date(event.occurredAt).toISOString(), id: event.id }),
  }));
  return {
    asOf: new Date().toISOString(),
    items,
    nextCursor: hasMore && items.length > 0 ? items.at(-1)!.cursor : null,
    hasMore,
  };
}

export async function listBoundedLogTail(
  db: Database,
  input: Omit<DaemonHistoryQuery, "kind" | "severity"> & { maxChars?: number },
  scope?: MetadataReadScope,
) {
  const history = await listCorrelatedHistory(db, { ...input, kind: "progress" }, scope);
  const requestedMaxChars = Number(input.maxChars ?? 4_000);
  const maxChars = Number.isFinite(requestedMaxChars)
    ? Math.min(20_000, Math.max(200, requestedMaxChars))
    : 4_000;
  let used = 0;
  const items = history.items.flatMap((event) => {
    const message = event.summary ?? "";
    if (!message || used >= maxChars) return [];
    const remaining = maxChars - used;
    const text = message.length > remaining ? `${message.slice(0, Math.max(0, remaining - 1))}…` : message;
    used += text.length;
    return [{ eventId: event.eventId, occurredAt: event.occurredAt, runId: event.runId, workerIndex: event.details.workerIndex ?? null, message: text, truncated: text !== message }];
  });
  return { asOf: history.asOf, items, nextCursor: history.nextCursor, hasMore: history.hasMore || used >= maxChars };
}

export async function listRequirementTimeline(
  db: Database,
  input: { requirementId: string; limit: number },
  scope?: MetadataReadScope,
) {
  const requirement = await db.query.requirements.findFirst({
    where: and(eq(requirements.id, input.requirementId), scope?.requirement),
    with: {
      tasks: true,
      executionSlices: true,
      repositories: { with: { repository: true } },
    },
  });
  if (!requirement) throw new NotFoundError("Requirement not found");

  const taskIds = requirement.tasks.map((task) => task.id);
  const activityCondition = taskIds.length > 0
    ? or(
        and(
          eq(activityLog.entityType, "requirement"),
          eq(activityLog.entityId, requirement.id),
        ),
        and(
          eq(activityLog.entityType, "task"),
          inArray(activityLog.entityId, taskIds),
        ),
      )
    : and(
        eq(activityLog.entityType, "requirement"),
        eq(activityLog.entityId, requirement.id),
      );
  const [progress, taskStatuses, activities] = await Promise.all([
    db.query.daemonWorkerProgressHistory.findMany({
      where: and(eq(daemonWorkerProgressHistory.requirementId, requirement.id), scope?.history),
      orderBy: desc(daemonWorkerProgressHistory.occurredAt),
      limit: input.limit,
    }),
    taskIds.length > 0
      ? db.query.taskStatusLog.findMany({
          where: inArray(taskStatusLog.taskId, taskIds),
          orderBy: desc(taskStatusLog.createdAt),
          limit: input.limit,
        })
      : Promise.resolve([]),
    db.query.activityLog.findMany({
      where: activityCondition,
      orderBy: desc(activityLog.createdAt),
      limit: input.limit,
    }),
  ]);

  const taskTitles = Object.fromEntries(requirement.tasks.map((task) => [task.id, task.title]));
  const sliceTitles = Object.fromEntries(requirement.executionSlices.map((slice) => [slice.id, slice.title]));
  const repositoryNames = Object.fromEntries(requirement.repositories.map((entry) => [
    entry.repositoryId,
    entry.repository.displayName,
  ]));
  return {
    requirement: {
      id: requirement.id,
      projectId: requirement.projectId,
      title: requirement.title,
      status: requirement.status,
    },
    events: buildDaemonTimeline({
      progress,
      taskStatuses,
      activities,
      repositories: requirement.repositories.map((entry) => ({
        id: entry.id,
        repositoryId: entry.repositoryId,
        repositoryName: entry.repository.displayName,
        deliveryStatus: entry.deliveryStatus,
        pushStatus: entry.pushStatus,
        reviewStatus: entry.reviewStatus,
        mergeStatus: entry.mergeStatus,
        failureCode: entry.failureCode,
        failureSummary: entry.failureSummary,
        retryCount: entry.retryCount,
        retryPhase: entry.retryPhase,
        retryRole: entry.retryRole,
        retryPolicy: entry.retryPolicy,
        resumeOperation: entry.resumeOperation,
        nextAttemptAt: entry.nextAttemptAt,
        pullRequestUrl: entry.pullRequestUrl,
        headCommit: entry.headCommit,
        pushedCommit: entry.pushedCommit,
        mergeMode: entry.mergeMode,
        manualActionUrl: entry.manualActionUrl,
        externalSyncRevision: entry.externalSyncRevision,
        externalStateUpdatedAt: entry.externalStateUpdatedAt,
        updatedAt: entry.updatedAt,
      })),
      taskTitles,
      sliceTitles,
      repositoryNames,
      limit: input.limit,
    }),
  };
}

export function progressPhaseForTaskStatus(status: TaskStatus): DaemonProgressPhase {
  if (status === "in_progress") return "executing";
  if (status === "in_review") return "awaiting_review";
  if (status === "done") return "task_completed";
  if (status === "cancelled") return "cancelled";
  return "claiming";
}

export async function recordTaskStatusProgress(
  db: Database,
  input: {
    daemonId: string;
    runId: string;
    workerIndex: number;
    leaseGeneration: number;
    projectId: string | null;
    requirementId: string;
    executionSliceId: string | null;
    taskId: string;
    taskStatus: TaskStatus;
    previousTaskStatus: TaskStatus;
    taskTitle: string;
    reason?: string;
    actor: Actor;
  },
) {
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, input.daemonId) });
  if (!daemon) return null;
  return persistWorkerProgress(db, {
    daemonId: input.daemonId,
    runId: input.runId,
    workerIndex: input.workerIndex,
    role: daemon.role ?? "executor",
    projectId: input.projectId,
    requirementId: input.requirementId,
    executionSliceId: input.executionSliceId,
    currentTaskId: input.taskId,
    phase: progressPhaseForTaskStatus(input.taskStatus),
    message: input.reason ?? `${input.taskTitle} moved to ${input.taskStatus}`,
    recoveryDisposition: input.taskStatus === "in_progress" ? "none" : undefined,
    lastCompletedTaskId: input.taskStatus === "done" ? input.taskId : undefined,
    source: "task_status",
    leaseGeneration: input.leaseGeneration,
    details: {
      fromStatus: input.previousTaskStatus,
      toStatus: input.taskStatus,
      actorId: input.actor.id,
      actorType: input.actor.type,
    },
  });
}

interface InterruptedWorkerInput {
  runId: string;
  workerIndex: number;
  requirementId: string;
  executionSliceId?: string | null;
  currentTaskId?: string | null;
  leaseGeneration: number;
  reason: string;
  workspaceState?: DaemonWorkspaceState;
  pendingDiffSummary?: string | null;
  sliceSummary?: string | null;
  handoffSummary?: string | null;
}

function recoveryDispositionForWorkspace(
  workspaceState: DaemonWorkspaceState,
): DaemonRecoveryDisposition {
  if (workspaceState === "conflicted" || workspaceState === "missing") return "quarantine";
  if (workspaceState === "dirty") return "resume";
  if (workspaceState === "unknown") return "retry";
  return "retry";
}

function normalizeWorkspaceState(value: unknown): DaemonWorkspaceState {
  return value === "clean"
    || value === "dirty"
    || value === "conflicted"
    || value === "missing"
    ? value
    : "unknown";
}

async function updateTaskForRecovery(
  db: ProgressDatabase,
  task: any,
  status: "todo" | "in_review",
  actor: Actor,
  reason: string,
) {
  if (task.status !== "in_progress") return false;
  const now = new Date();
  const [updated] = await db.update(tasks).set({
    status,
    completedAt: null,
    version: task.version + 1,
    updatedAt: now,
  }).where(eq(tasks.id, task.id)).returning();
  if (!updated) return false;

  await db.insert(taskStatusLog).values({
    taskId: task.id,
    fromStatus: task.status,
    toStatus: status,
    changedBy: actor.id,
    changedByType: actor.type,
    reason,
  });
  await db.insert(activityLog).values({
    entityType: "task",
    entityId: task.id,
    action: "status_changed",
    actorId: actor.id,
    actorType: actor.type,
    metadata: { from: task.status, to: status, reason, recovery: true },
  });
  emit({
    type: "task_status_changed",
    projectId: task.projectId,
    taskId: task.id,
    from: task.status,
    to: status,
  });
  return true;
}

async function reconcileInterruptedWorkerInTransaction(
  db: ProgressDatabase,
  daemon: { id: string; role?: DaemonRole | null },
  input: InterruptedWorkerInput,
  actor: Actor,
) {
  const requirement = await db.query.requirements.findFirst({
    where: eq(requirements.id, input.requirementId),
    with: {
      tasks: {
        orderBy: (task, { asc }) => [asc(task.createdAt)],
      },
    },
  });
  if (!requirement) throw new NotFoundError("Requirement not found");

  const current = await db.query.daemonWorkerProgress.findFirst({
    where: and(
      eq(daemonWorkerProgress.daemonId, daemon.id),
      eq(daemonWorkerProgress.workerIndex, input.workerIndex),
    ),
  });
  const workspaceState = normalizeWorkspaceState(input.workspaceState ?? current?.workspaceState);
  const disposition = recoveryDispositionForWorkspace(workspaceState);
  const activeTasks = requirement.tasks.filter((task: any) => task.status === "in_progress");
  const terminalTasks = requirement.tasks.filter(
    (task: any) => task.status === "done" || task.status === "cancelled",
  );
  const currentTaskId = current?.runId === input.runId
    && current.requirementId === input.requirementId
    && current.leaseGeneration === input.leaseGeneration
    ? current.currentTaskId
    : input.currentTaskId ?? null;
  const authoritativeTask = activeTasks.find((task: any) => task.id === currentTaskId) ?? null;
  const targetStatus = disposition === "quarantine" ? "in_review" : "todo";
  const multiActive = activeTasks.length > 1;
  const recoveryReason = multiActive
    ? `${input.reason}; reconciled ${activeTasks.length} concurrently active tasks`
    : input.reason;
  const recoveredTaskIds: string[] = [];

  for (const task of activeTasks) {
    if (await updateTaskForRecovery(db, task, targetStatus, actor, recoveryReason)) {
      recoveredTaskIds.push(task.id);
    }
  }

  const executionSliceId = input.executionSliceId
    ?? current?.executionSliceId
    ?? authoritativeTask?.executionSliceId
    ?? null;
  const lastCompletedTask = [...terminalTasks]
    .filter((task: any) => task.status === "done")
    .sort((a: any, b: any) => {
      const aTime = a.completedAt?.getTime?.() ?? a.updatedAt?.getTime?.() ?? 0;
      const bTime = b.completedAt?.getTime?.() ?? b.updatedAt?.getTime?.() ?? 0;
      return bTime - aTime;
    })[0] ?? null;
  const handoffSummary = input.handoffSummary
    ?? `${recoveredTaskIds.length} active task(s) moved to ${targetStatus}; ${terminalTasks.length} terminal task(s) preserved.`;
  const sliceSummary = input.sliceSummary
    ?? `${recoveryReason}. Recovery disposition: ${disposition}.`;

  if (executionSliceId) {
    await db.update(executionSlices).set({
      status: disposition === "quarantine" ? "in_review" : "todo",
      resultSummary: sliceSummary,
      updatedAt: new Date(),
    }).where(eq(executionSlices.id, executionSliceId));
  }

  const progress = await persistWorkerProgress(db, {
    daemonId: daemon.id,
    runId: input.runId,
    workerIndex: input.workerIndex,
    role: daemon.role ?? "executor",
    projectId: requirement.projectId,
    requirementId: input.requirementId,
    executionSliceId,
    currentTaskId: authoritativeTask?.id ?? currentTaskId,
    phase: disposition === "quarantine" ? "quarantined" : "recovering",
    message: recoveryReason,
    workspaceState,
    recoveryDisposition: disposition,
    retryCount: (current?.retryCount ?? 0) + 1,
    lastCompletedTaskId: lastCompletedTask?.id ?? current?.lastCompletedTaskId ?? null,
    pendingDiffSummary: input.pendingDiffSummary ?? current?.pendingDiffSummary ?? null,
    sliceSummary,
    handoffSummary,
    source: "recovery",
    leaseGeneration: input.leaseGeneration,
    details: {
      activeTaskIds: activeTasks.map((task: any) => task.id),
      recoveredTaskIds,
      preservedTerminalTaskIds: terminalTasks.map((task: any) => task.id),
      authoritativeTaskId: authoritativeTask?.id ?? null,
      multiActive,
      targetStatus,
    },
  });

  return {
    progress,
    recoveredTaskIds,
    preservedTerminalTaskIds: terminalTasks.map((task: any) => task.id),
    authoritativeTaskId: authoritativeTask?.id ?? null,
    multiActive,
    recoveryDisposition: disposition,
  };
}

export async function reconcileInterruptedWorker(
  db: Database,
  daemon: { id: string; role?: DaemonRole | null },
  input: InterruptedWorkerInput,
  actor: Actor,
) {
  return db.transaction((tx) => reconcileInterruptedWorkerInTransaction(
    tx,
    daemon,
    input,
    actor,
  ));
}

export async function reconcileWorkerRun(
  db: Database,
  daemonId: string,
  input: ReconcileDaemonWorkerInput,
  actor: Actor,
) {
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
  if (!daemon) throw new NotFoundError("Daemon not found");
  assertDaemonOwner(daemon, actor);
  const claim = await assertRequirementLease(
    db,
    input.requirementId,
    actor,
    { daemonId, leaseGeneration: input.leaseGeneration },
    true,
  );
  if (!claim || claim.id !== input.runId) {
    throw new ValidationError("Recovery runId must match the active Requirement claim");
  }
  if (claim.workerIndex !== null && claim.workerIndex !== String(input.workerIndex)) {
    throw new ValidationError("Recovery worker index must match the active Requirement claim");
  }
  return reconcileInterruptedWorker(db, daemon, input, actor);
}
