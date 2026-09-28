import { desc, inArray } from "drizzle-orm";
import {
  daemons,
  daemonWorkerProgress,
  daemonWorkerProgressHistory,
  executionSlices,
  requirementClaims,
  requirements,
  tasks,
  type Database,
} from "@task-weaver/db";
import type {
  DaemonObservabilityQuery,
  ObservabilityAlert,
  ObservabilityHealth,
  ObservabilityNextAction,
  ObservabilityForecastEntity,
  ObservabilityLiveness,
} from "../schemas/observability";
import { listDaemonControlPlaneQueues } from "./daemons";

const STALE_AFTER_MS = 30_000;
const OFFLINE_AFTER_MS = 60_000;
const LEASE_RISK_AFTER_MS = 5 * 60_000;
const NO_PROGRESS_AFTER_MS = 5 * 60_000;

function asDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value: Date | string | null | undefined) {
  return asDate(value)?.toISOString() ?? null;
}

function livenessFor(daemon: { status: string; lastHeartbeatAt: Date | string }, asOf: Date): ObservabilityLiveness {
  if (daemon.status === "offline") return "offline";
  const age = asOf.getTime() - (asDate(daemon.lastHeartbeatAt)?.getTime() ?? 0);
  if (age >= OFFLINE_AFTER_MS) return "offline";
  if (age >= STALE_AFTER_MS) return "stale";
  return "online";
}

function healthFor(alerts: ObservabilityAlert[]): ObservabilityHealth {
  if (alerts.some((alert) => alert.severity === "error")) return "unhealthy";
  if (alerts.some((alert) => alert.severity === "warn")) return "degraded";
  return "healthy";
}

function workerActivityState(worker: Record<string, unknown>): "idle" | "claiming" | "running" | "stopping" | "failed" {
  const value = worker.status;
  return value === "claiming" || value === "running" || value === "stopping" || value === "failed"
    ? value
    : "idle";
}

function forecast(input: {
  kind: ObservabilityNextAction["kind"];
  reason: string;
  trigger: string;
  policy: string;
  at?: string | null;
  confidence?: ObservabilityNextAction["confidence"];
  blockingEntity?: ObservabilityForecastEntity | null;
  requiredRole?: ObservabilityNextAction["requiredRole"];
  requiredCapability?: string | null;
  requirementId?: string | null;
  taskId?: string | null;
  daemonId?: string | null;
  workerIndex?: number | null;
}): ObservabilityNextAction {
  const at = input.at ?? null;
  return {
    kind: input.kind,
    reason: input.reason,
    trigger: input.trigger,
    policy: input.policy,
    at,
    nextActionAt: at,
    confidence: input.confidence ?? "unknown",
    blockingEntity: input.blockingEntity ?? null,
    requiredRole: input.requiredRole ?? null,
    requiredCapability: input.requiredCapability ?? null,
    requirementId: input.requirementId ?? null,
    taskId: input.taskId ?? null,
    daemonId: input.daemonId ?? null,
    workerIndex: input.workerIndex ?? null,
  };
}

/**
 * Build one internally consistent observability snapshot. All relationship
 * lookups are batched by ID so the overview does not perform one query per
 * daemon card or worker card.
 */
export async function getDaemonObservabilityOverview(
  db: Database,
  input: DaemonObservabilityQuery,
) {
  const asOf = new Date();
  const [daemonRows, progressRows, historyRows, queue] = await Promise.all([
    db.query.daemons.findMany({ orderBy: daemons.name }),
    db.query.daemonWorkerProgress.findMany({ orderBy: desc(daemonWorkerProgress.updatedAt) }),
    db.query.daemonWorkerProgressHistory.findMany({
      orderBy: [desc(daemonWorkerProgressHistory.occurredAt), desc(daemonWorkerProgressHistory.id)],
      limit: input.limit,
    }),
    listDaemonControlPlaneQueues(db),
  ]);

  const relevantProgress = progressRows;
  const requirementIds = [...new Set(relevantProgress.map((row) => row.requirementId))];
  const taskIds = [...new Set(relevantProgress.flatMap((row) => [row.currentTaskId, row.lastCompletedTaskId]).filter((id): id is string => Boolean(id)))];
  const sliceIds = [...new Set(relevantProgress.map((row) => row.executionSliceId).filter((id): id is string => Boolean(id)))];

  const [requirementRows, taskRows, sliceRows, claimRows] = await Promise.all([
    requirementIds.length > 0
      ? db.query.requirements.findMany({ where: inArray(requirements.id, requirementIds) })
      : Promise.resolve([]),
    taskIds.length > 0
      ? db.query.tasks.findMany({ where: inArray(tasks.id, taskIds) })
      : Promise.resolve([]),
    sliceIds.length > 0
      ? db.query.executionSlices.findMany({ where: inArray(executionSlices.id, sliceIds) })
      : Promise.resolve([]),
    requirementIds.length > 0
      ? db.query.requirementClaims.findMany({ where: inArray(requirementClaims.requirementId, requirementIds) })
      : Promise.resolve([]),
  ]);

  const requirementById = new Map(requirementRows.map((row) => [row.id, row]));
  const taskById = new Map(taskRows.map((row) => [row.id, row]));
  const sliceById = new Map(sliceRows.map((row) => [row.id, row]));
  const claimByRequirement = new Map(claimRows.map((row) => [row.requirementId, row]));
  const progressByDaemon = new Map<string, typeof progressRows>();
  for (const progress of relevantProgress) {
    const requirement = requirementById.get(progress.requirementId);
    if (input.projectId && requirement?.projectId !== input.projectId) continue;
    const current = progressByDaemon.get(progress.daemonId) ?? [];
    current.push(progress);
    progressByDaemon.set(progress.daemonId, current);
  }

  const alerts: ObservabilityAlert[] = [];
  const nextActions: ObservabilityNextAction[] = [];
  const daemonItems = daemonRows
    .map((daemon) => {
      const liveness = livenessFor(daemon, asOf);
      if (!input.includeOffline && liveness === "offline") return null;
      const daemonProgress = progressByDaemon.get(daemon.id) ?? [];
      const rawWorkers: Array<Record<string, unknown>> = Array.isArray(daemon.activeWorkerStates)
        ? daemon.activeWorkerStates as Array<Record<string, unknown>>
        : [];
      const workerIndexes = new Set(rawWorkers.map((worker) => Number(worker.index ?? worker.workerIndex ?? -1)));
      const workers = [
        ...rawWorkers.map((worker) => ({ worker, progress: daemonProgress.find((row) => row.workerIndex === Number(worker.index ?? worker.workerIndex ?? -1)) })),
        ...daemonProgress
          .filter((row) => !workerIndexes.has(row.workerIndex))
          .map((progress) => ({ worker: { index: progress.workerIndex, status: "running" } as Record<string, unknown>, progress })),
      ].slice(0, input.limit).map(({ worker, progress }) => {
        const requirement = progress ? requirementById.get(progress.requirementId) : null;
        const claim = progress ? claimByRequirement.get(progress.requirementId) : null;
        const task = progress?.currentTaskId ? taskById.get(progress.currentTaskId) : null;
        const slice = progress?.executionSliceId ? sliceById.get(progress.executionSliceId) : null;
        const workerStatus = workerActivityState(worker);
        const workerUpdatedAt = worker.updatedAt instanceof Date || typeof worker.updatedAt === "string"
          ? worker.updatedAt
          : null;
        const lastEvent = asDate(progress?.lastEventAt ?? workerUpdatedAt);
        const leaseExpiresAt = asDate(claim?.expiresAt);
        if (workerStatus === "failed") {
          alerts.push({
            code: "worker_failed",
            severity: "error",
            message: `Worker ${String(worker.index ?? progress?.workerIndex ?? "?")} reported a failure`,
            daemonId: daemon.id,
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
          });
          nextActions.push(forecast({
            kind: "operator",
            reason: "Worker failed and needs inspection or recovery",
            trigger: "worker.status=failed",
            policy: "worker-failure-recovery",
            confidence: "deterministic",
            blockingEntity: {
              kind: "worker",
              id: null,
              label: `Worker ${String(worker.index ?? progress?.workerIndex ?? "?")}`,
            },
            requiredRole: "operator",
            requiredCapability: "daemon.recovery",
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
            daemonId: daemon.id,
            workerIndex: progress?.workerIndex ?? Number(worker.index ?? 0),
          }));
        }
        if (leaseExpiresAt && leaseExpiresAt.getTime() - asOf.getTime() <= LEASE_RISK_AFTER_MS) {
          alerts.push({
            code: "lease_at_risk",
            severity: "warn",
            message: `Worker lease expires at ${leaseExpiresAt.toISOString()}`,
            daemonId: daemon.id,
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
          });
          nextActions.push(forecast({
            kind: "resume",
            reason: "Renew or recover the worker lease before it expires",
            trigger: `lease.expiresAt<=${LEASE_RISK_AFTER_MS / 60_000}m`,
            policy: "lease-renewal-before-expiry",
            at: iso(leaseExpiresAt),
            confidence: "deterministic",
            blockingEntity: {
              kind: "claim",
              id: progress?.requirementId ?? null,
              label: `Lease for ${requirement?.title ?? "active requirement"}`,
            },
            requiredRole: daemon.role === "executor" || daemon.role === "reviewer" || daemon.role === "merger" ? daemon.role : "operator",
            requiredCapability: "daemon.heartbeat",
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
            daemonId: daemon.id,
            workerIndex: progress?.workerIndex ?? Number(worker.index ?? 0),
          }));
        }
        if (workerStatus === "running" && lastEvent && asOf.getTime() - lastEvent.getTime() > NO_PROGRESS_AFTER_MS) {
          alerts.push({
            code: "worker_no_progress",
            severity: "warn",
            message: `No worker progress event since ${lastEvent.toISOString()}`,
            daemonId: daemon.id,
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
          });
          nextActions.push(forecast({
            kind: "operator",
            reason: "Inspect the stalled worker and decide whether to retry or recover",
            trigger: `lastEventAt>${NO_PROGRESS_AFTER_MS / 60_000}m ago`,
            policy: "no-progress-manual-recovery",
            confidence: "deterministic",
            blockingEntity: {
              kind: "worker",
              id: null,
              label: `Worker ${String(worker.index ?? progress?.workerIndex ?? "?")}`,
            },
            requiredRole: "operator",
            requiredCapability: "daemon.recovery",
            requirementId: progress?.requirementId ?? null,
            taskId: progress?.currentTaskId ?? null,
            daemonId: daemon.id,
            workerIndex: progress?.workerIndex ?? Number(worker.index ?? 0),
          }));
        }
        return {
          index: Number(worker.index ?? progress?.workerIndex ?? 0),
          status: workerStatus,
          requirementId: progress?.requirementId ?? (typeof worker.requirementId === "string" ? worker.requirementId : null),
          requirementTitle: requirement?.title ?? (typeof worker.requirementTitle === "string" ? worker.requirementTitle : null),
          executionSliceId: progress?.executionSliceId ?? (typeof worker.executionSliceId === "string" ? worker.executionSliceId : null),
          executionSliceTitle: slice?.title ?? (typeof worker.executionSliceTitle === "string" ? worker.executionSliceTitle : null),
          taskId: progress?.currentTaskId ?? (typeof worker.taskId === "string" ? worker.taskId : null),
          taskTitle: task?.title ?? (typeof worker.taskTitle === "string" ? worker.taskTitle : null),
          runId: progress?.runId ?? (typeof worker.runId === "string" ? worker.runId : null),
          phase: progress?.phase ?? (typeof worker.progressPhase === "string" ? worker.progressPhase : null),
          workspaceState: progress?.workspaceState ?? "unknown",
          recoveryDisposition: progress?.recoveryDisposition ?? "none",
          lastEventAt: iso(lastEvent),
          lease: claim
            ? { generation: claim.generation, expiresAt: iso(claim.expiresAt), heartbeatAt: iso(claim.heartbeatAt) }
            : null,
        };
      });
      if (liveness === "offline") {
        alerts.push({
          code: "daemon_offline",
          severity: "error",
          message: `Daemon has not sent a heartbeat since ${iso(daemon.lastHeartbeatAt) ?? "unknown"}`,
          daemonId: daemon.id,
          requirementId: null,
          taskId: null,
        });
      } else if (liveness === "stale") {
        alerts.push({
          code: "daemon_stale",
          severity: "warn",
          message: `Daemon heartbeat is stale (last seen ${iso(daemon.lastHeartbeatAt) ?? "unknown"})`,
          daemonId: daemon.id,
          requirementId: null,
          taskId: null,
        });
      }
      if (liveness === "offline" || liveness === "stale") {
        nextActions.push(forecast({
          kind: "operator",
          reason: liveness === "offline"
            ? "Restart or inspect the offline daemon before assigning work"
            : "Check the daemon heartbeat and lease renewal path",
          trigger: `daemon.liveness=${liveness}`,
          policy: "daemon-liveness-recovery",
          confidence: "deterministic",
          blockingEntity: { kind: "daemon", id: daemon.id, label: daemon.name },
          requiredRole: "operator",
          requiredCapability: "daemon.diagnostics",
          daemonId: daemon.id,
        }));
      }
      return {
        id: daemon.id,
        instanceId: daemon.id,
        name: daemon.name,
        role: daemon.role ?? "executor",
        status: daemon.status,
        controlState: daemon.controlState ?? "running",
        controlReason: daemon.controlReason ?? null,
        liveness,
        health: "healthy" as ObservabilityHealth,
        host: daemon.host ?? null,
        workerCapacity: daemon.workerCapacity,
        activeWorkerCount: workers.filter((worker) => worker.status !== "idle").length,
        lastHeartbeatAt: iso(daemon.lastHeartbeatAt),
        processStartedAt: iso(daemon.processStartedAt),
        workers,
      };
    })
    .filter((daemon): daemon is NonNullable<typeof daemon> => daemon !== null);

  for (const item of queue.items.filter((candidate) => !input.projectId || candidate.projectId === input.projectId).slice(0, input.limit)) {
    if (item.state === "blocked") {
      alerts.push({
        code: "queue_blocked",
        severity: "warn",
        message: item.reasons[0] ?? "Queue item is blocked",
        daemonId: null,
        requirementId: item.requirementId,
        taskId: item.taskId,
      });
    }
    const kind: ObservabilityNextAction["kind"] = item.state === "retrying"
      ? "retry"
      : item.state === "manual"
        ? "operator"
        : item.state === "runnable"
          ? "run"
          : "wait";
    const requiredRole = item.role === "executor" || item.role === "reviewer" || item.role === "merger" || item.role === "operator"
      ? item.role
      : "operator";
    nextActions.push(forecast({
      kind,
      reason: item.reasons[0] ?? `Queue item is ${item.state}`,
      trigger: `queue.state=${item.state}; reasonCodes=${item.reasonCodes.join(",") || "none"}`,
      policy: item.state === "blocked"
        ? "queue-dependency-and-capability-gating"
        : item.state === "retrying"
          ? "repository-retry-policy"
          : item.state === "manual"
            ? "manual-handoff-policy"
            : "role-capability-scheduler",
      at: iso(item.nextAttemptAt),
      confidence: item.state === "blocked" ? "unknown" : "deterministic",
      blockingEntity: item.state === "blocked"
        ? {
            kind: item.reasonCodes.includes("dependency") ? "requirement" : item.reasonCodes.includes("slice_order") ? "slice" : item.reasonCodes.includes("capability") ? "capability" : "requirement",
            id: item.reasonCodes.includes("slice_order") ? item.executionSliceId : item.requirementId,
            label: item.reasons[0] ?? `Requirement ${item.requirementId}`,
          }
        : item.state === "retrying"
          ? { kind: "repository", id: item.repositories[0]?.repositoryId ?? null, label: item.repositories[0]?.repositoryName ?? "repository delivery" }
          : null,
      requiredRole,
      requiredCapability: requiredRole === "operator" ? "operator.intervention" : `${requiredRole}.work`,
      requirementId: item.requirementId,
      taskId: item.taskId,
      daemonId: null,
      workerIndex: null,
    }));
  }

  const latestEvent = historyRows[0];
  const eventCursor = latestEvent
    ? `${asDate(latestEvent.occurredAt)?.toISOString() ?? ""}:${latestEvent.id}`
    : null;
  const scopedQueueItems = queue.items.filter((item) => !input.projectId || item.projectId === input.projectId);
  const byState = scopedQueueItems.reduce<Record<string, number>>((counts, item) => {
    counts[item.state] = (counts[item.state] ?? 0) + 1;
    return counts;
  }, {});
  const uniqueAlerts = alerts.filter((alert, index) => alerts.findIndex((candidate) =>
    candidate.code === alert.code
      && candidate.daemonId === alert.daemonId
      && candidate.requirementId === alert.requirementId
      && candidate.taskId === alert.taskId,
  ) === index);
  const finalHealth = healthFor(uniqueAlerts);
  for (const daemon of daemonItems) daemon.health = healthFor(uniqueAlerts.filter((alert) => alert.daemonId === daemon.id));
  return {
    asOf: asOf.toISOString(),
    eventCursor,
    health: finalHealth,
    daemons: daemonItems,
    queue: {
      total: scopedQueueItems.length,
      byState,
      items: scopedQueueItems.slice(0, input.limit),
    },
    alerts: uniqueAlerts.slice(0, input.limit),
    nextActions: nextActions.slice(0, input.limit),
  };
}
