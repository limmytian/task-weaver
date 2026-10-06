import type { MetadataReadScope } from "./metadata-read-scope";
import { and, gte, inArray } from "drizzle-orm";
import {
  daemonWorkerProgressHistory,
  daemons,
  requirements,
  type Database,
} from "@task-weaver/db";
import type { DaemonMetricsQuery } from "@task-weaver/contracts";
import { listDaemonControlPlaneQueues } from "./daemons";

const STALE_AFTER_MS = 30_000;
const OFFLINE_AFTER_MS = 60_000;

export interface DaemonMetricsSnapshot {
  asOf: Date;
  daemons: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    workerCapacity: number;
    lastHeartbeatAt: Date | string;
  }>;
  progress: Array<{
    daemonId: string;
    workerIndex: number;
    phase: string;
    retryCount: number;
    lastEventAt: Date | string;
    updatedAt: Date | string;
  }>;
  history: Array<{
    id: string;
    daemonId: string;
    workerIndex: number;
    phase: string;
    retryCount: number;
    occurredAt: Date | string;
  }>;
  queue: Array<{
    state: string;
    reasonCodes: string[];
    retryCount: number;
    repositories: Array<{ retryExhausted: boolean }>;
  }>;
}

export interface DaemonMetricValues {
  capacity: number;
  activeWorkers: number;
  queueDepth: number;
  heartbeatGapSeconds: number;
  noProgressSeconds: number;
  progressEvents: number;
  retryEvents: number;
  recoveryEvents: number;
  reviewEvents: number;
  mergeEvents: number;
}

export interface DaemonMetricPoint {
  at: string;
  sampleCount: number;
  values: DaemonMetricValues;
}

export interface DaemonMetricSeries {
  id: string;
  label: string;
  role: string;
  points: DaemonMetricPoint[];
}

export interface DaemonMetricAlert {
  id: string;
  code: "daemon_stale" | "daemon_offline" | "stranded_lane" | "retry_exhaustion" | "manual_handoff";
  severity: "info" | "warn" | "error";
  message: string;
  runbook: string;
  daemonId: string | null;
  requirementId: string | null;
}

export interface DaemonMetricsReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  windowHours: number;
  bucketMinutes: number;
  sampleCount: number;
  noData: boolean;
  series: DaemonMetricSeries[];
  alerts: DaemonMetricAlert[];
}

function timestamp(value: Date | string) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function bucketFor(value: Date | string, start: number, bucketMs: number, bucketCount: number) {
  const index = Math.floor((timestamp(value) - start) / bucketMs);
  return Math.max(0, Math.min(bucketCount - 1, index));
}

function emptyValues(capacity: number, queueDepth: number, heartbeatGapSeconds: number, noProgressSeconds: number): DaemonMetricValues {
  return {
    capacity,
    activeWorkers: 0,
    queueDepth,
    heartbeatGapSeconds,
    noProgressSeconds,
    progressEvents: 0,
    retryEvents: 0,
    recoveryEvents: 0,
    reviewEvents: 0,
    mergeEvents: 0,
  };
}

function phaseCounter(values: DaemonMetricValues, phase: string) {
  if (phase === "recovering" || phase === "failed") values.recoveryEvents += 1;
  if (phase === "reviewing" || phase === "awaiting_review") values.reviewEvents += 1;
  if (phase === "merging" || phase === "finalizing") values.mergeEvents += 1;
}

function buildPoints(
  snapshot: DaemonMetricsSnapshot,
  daemonId: string | null,
  windowStart: Date,
  bucketMinutes: number,
  now: Date,
): DaemonMetricPoint[] {
  const bucketMs = bucketMinutes * 60_000;
  const bucketCount = Math.max(1, Math.ceil((now.getTime() - windowStart.getTime()) / bucketMs));
  const selectedDaemons = daemonId
    ? snapshot.daemons.filter((daemon) => daemon.id === daemonId)
    : snapshot.daemons;
  const capacity = selectedDaemons.reduce((sum, daemon) => sum + daemon.workerCapacity, 0);
  const queueDepth = snapshot.queue.length;
  const heartbeatGapSeconds = selectedDaemons.length === 0
    ? 0
    : Math.max(...selectedDaemons.map((daemon) => Math.max(0, (now.getTime() - timestamp(daemon.lastHeartbeatAt)) / 1_000)));
  const selectedProgress = snapshot.progress.filter((row) => !daemonId || row.daemonId === daemonId);
  const noProgressSeconds = selectedProgress.length === 0
    ? 0
    : Math.max(...selectedProgress.map((row) => Math.max(0, (now.getTime() - timestamp(row.lastEventAt)) / 1_000)));
  const points = Array.from({ length: bucketCount }, (_, index) => {
    const at = new Date(windowStart.getTime() + (index + 1) * bucketMs);
    const values = emptyValues(capacity, queueDepth, heartbeatGapSeconds, noProgressSeconds);
    const history = snapshot.history.filter((row) =>
      (!daemonId || row.daemonId === daemonId)
      && bucketFor(row.occurredAt, windowStart.getTime(), bucketMs, bucketCount) === index,
    );
    const workerIndexes = new Set<number>();
    for (const row of history) {
      workerIndexes.add(row.workerIndex);
      values.progressEvents += 1;
      if (row.retryCount > 0 || row.phase === "recovering") values.retryEvents += 1;
      phaseCounter(values, row.phase);
    }
    values.activeWorkers = workerIndexes.size;
    return {
      at: at.toISOString(),
      sampleCount: history.length,
      values,
    };
  });
  return points;
}

export function buildDaemonMetricsReport(
  snapshot: DaemonMetricsSnapshot,
  query: DaemonMetricsQuery,
  now = snapshot.asOf,
): DaemonMetricsReport {
  const windowStart = new Date(now.getTime() - query.windowHours * 3_600_000);
  const series: DaemonMetricSeries[] = snapshot.daemons.map((daemon) => ({
    id: daemon.id,
    label: daemon.name,
    role: daemon.role,
    points: buildPoints(snapshot, daemon.id, windowStart, query.bucketMinutes, now),
  }));
  const aggregate = buildPoints(snapshot, null, windowStart, query.bucketMinutes, now);
  series.unshift({ id: "aggregate", label: "All daemons", role: "all", points: aggregate });

  const alerts: DaemonMetricAlert[] = [];
  for (const daemon of snapshot.daemons) {
    const gap = now.getTime() - timestamp(daemon.lastHeartbeatAt);
    if (daemon.status === "offline" || gap >= OFFLINE_AFTER_MS) {
      alerts.push({
        id: `daemon-offline:${daemon.id}`,
        code: "daemon_offline",
        severity: "error",
        message: `${daemon.name} is offline; heartbeat gap is ${Math.round(gap / 1_000)}s`,
        runbook: "#heartbeat-and-lease-health",
        daemonId: daemon.id,
        requirementId: null,
      });
    } else if (gap >= STALE_AFTER_MS) {
      alerts.push({
        id: `daemon-stale:${daemon.id}`,
        code: "daemon_stale",
        severity: "warn",
        message: `${daemon.name} heartbeat is stale; last seen ${Math.round(gap / 1_000)}s ago`,
        runbook: "#heartbeat-and-lease-health",
        daemonId: daemon.id,
        requirementId: null,
      });
    }
  }
  for (const [index, item] of snapshot.queue.entries()) {
    if (item.state === "blocked") {
      alerts.push({
        id: `stranded:${index}`,
        code: "stranded_lane",
        severity: "warn",
        message: `Queue lane is blocked (${item.reasonCodes.join(", ") || "unknown reason"})`,
        runbook: "#completion-and-stranded-lanes",
        daemonId: null,
        requirementId: null,
      });
    }
    if (item.state === "manual") {
      alerts.push({
        id: `manual:${index}`,
        code: "manual_handoff",
        severity: "warn",
        message: "Queue lane requires a manual operator handoff",
        runbook: "#retry-and-recovery",
        daemonId: null,
        requirementId: null,
      });
    }
    if (item.repositories.some((repository) => repository.retryExhausted) || item.retryCount >= 3) {
      alerts.push({
        id: `retry-exhaustion:${index}`,
        code: "retry_exhaustion",
        severity: "error",
        message: "Repository delivery retry budget is exhausted",
        runbook: "#retry-and-recovery",
        daemonId: null,
        requirementId: null,
      });
    }
  }
  const sampleCount = snapshot.history.length;
  return {
    generatedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    windowHours: query.windowHours,
    bucketMinutes: query.bucketMinutes,
    sampleCount,
    noData: sampleCount === 0,
    series,
    alerts,
  };
}

export async function getDaemonMetricsReport(
  db: Database,
  query: DaemonMetricsQuery,
  now = new Date(),
  scope?: MetadataReadScope,
): Promise<DaemonMetricsReport> {
  const windowStart = new Date(now.getTime() - query.windowHours * 3_600_000);
  const [daemonRows, progressRows, historyRows, queue] = await Promise.all([
    db.query.daemons.findMany({ where: scope?.daemon, orderBy: daemons.name }),
    db.query.daemonWorkerProgress.findMany({ where: scope?.progress }),
    db.query.daemonWorkerProgressHistory.findMany({
      where: and(gte(daemonWorkerProgressHistory.occurredAt, windowStart), scope?.history),
    }),
    listDaemonControlPlaneQueues(db, scope),
  ]);
  let progress = progressRows;
  let history = historyRows;
  if (query.projectId) {
    const requirementIds = [...new Set([
      ...progressRows.map((row) => row.requirementId),
      ...historyRows.map((row) => row.requirementId),
    ])];
    const projectRequirements = requirementIds.length > 0
      ? await db.query.requirements.findMany({
          where: and(inArray(requirements.id, requirementIds)),
        })
      : [];
    const projectRequirementIds = new Set(projectRequirements.filter((row) => row.projectId === query.projectId).map((row) => row.id));
    progress = progressRows.filter((row) => projectRequirementIds.has(row.requirementId));
    history = historyRows.filter((row) => projectRequirementIds.has(row.requirementId));
  }
  const daemonIds = new Set(progress.map((row) => row.daemonId));
  const scopedDaemons = query.projectId
    ? daemonRows.filter((daemon) => daemonIds.has(daemon.id))
    : daemonRows;
  const scopedQueue = query.projectId
    ? queue.items.filter((item) => item.projectId === query.projectId)
    : queue.items;
  return buildDaemonMetricsReport({
    asOf: now,
    daemons: scopedDaemons,
    progress,
    history,
    queue: scopedQueue,
  }, query, now);
}
