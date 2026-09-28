import { and, gte, inArray, or } from "drizzle-orm";
import {
  activityLog,
  daemons,
  type Database,
  requirementClaims,
  requirementRepositories,
  requirements,
  reviewRuns,
} from "@task-weaver/db";
import type { DaemonSloQuery } from "../schemas/daemons";

export type DaemonSloMetricId =
  | "acquisition_latency_p95"
  | "heartbeat_gap_p99"
  | "completion_rate"
  | "retry_recovery_rate"
  | "stranded_lanes"
  | "review_duration_p95"
  | "merge_latency_p95"
  | "recovery_time_p95";

export interface DaemonSloObjective {
  id: DaemonSloMetricId;
  label: string;
  description: string;
  unit: "seconds" | "ratio" | "count";
  comparator: "lte" | "gte";
  target: number;
  minimumSamples: number;
  releaseBlocking: boolean;
  runbook: string;
}

export interface DaemonSloMetric extends DaemonSloObjective {
  value: number | null;
  sampleCount: number;
  status: "pass" | "breach" | "no_data";
  displayValue: string;
}

export interface DaemonSloAlert {
  id: string;
  metricId: DaemonSloMetricId;
  severity: "warning" | "critical";
  title: string;
  summary: string;
  runbook: string;
}

export interface DaemonSloReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  windowHours: number;
  releaseStatus: "pass" | "blocked";
  metrics: DaemonSloMetric[];
  alerts: DaemonSloAlert[];
  counts: {
    daemons: number;
    requirements: number;
    terminalRequirements: number;
    repositoryDeliveries: number;
  };
}

export interface DaemonSloSnapshot {
  daemons: Array<{
    id: string;
    status: string;
    lastHeartbeatAt: Date | string;
  }>;
  requirements: Array<{
    id: string;
    status: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>;
  claims: Array<{
    requirementId: string;
    expiresAt: Date | string;
    heartbeatAt: Date | string;
    createdAt: Date | string;
  }>;
  activities: Array<{
    entityId: string;
    action: string;
    metadata: unknown;
    createdAt: Date | string;
  }>;
  reviewRuns: Array<{
    requirementRepositoryId: string;
    status: string;
    startedAt: Date | string;
    completedAt: Date | string | null;
  }>;
  deliveries: Array<{
    id: string;
    requirementId: string;
    deliveryStatus: string;
    retryCount: number;
    lastAttemptAt: Date | string | null;
    mergedAt: Date | string | null;
    updatedAt: Date | string;
  }>;
}

export const DAEMON_SLO_OBJECTIVES: readonly DaemonSloObjective[] = [
  {
    id: "acquisition_latency_p95",
    label: "Acquisition latency p95",
    description: "Time from an approved Requirement becoming eligible to its first daemon claim.",
    unit: "seconds",
    comparator: "lte",
    target: 30,
    minimumSamples: 2,
    releaseBlocking: true,
    runbook: "#acquisition-and-stranded-lanes",
  },
  {
    id: "heartbeat_gap_p99",
    label: "Heartbeat gap p99",
    description: "Age of the most recent process heartbeat for daemon instances seen in the window.",
    unit: "seconds",
    comparator: "lte",
    target: 45,
    minimumSamples: 1,
    releaseBlocking: true,
    runbook: "#heartbeat-and-lease-health",
  },
  {
    id: "completion_rate",
    label: "Completion rate",
    description: "Done Requirements as a fraction of terminal Requirements in the window.",
    unit: "ratio",
    comparator: "gte",
    target: 0.95,
    minimumSamples: 2,
    releaseBlocking: true,
    runbook: "#completion-and-stranded-lanes",
  },
  {
    id: "retry_recovery_rate",
    label: "Retry recovery rate",
    description: "Retried repository deliveries that ultimately reached merged or unchanged.",
    unit: "ratio",
    comparator: "gte",
    target: 0.9,
    minimumSamples: 1,
    releaseBlocking: false,
    runbook: "#retry-and-recovery",
  },
  {
    id: "stranded_lanes",
    label: "Stranded lanes",
    description: "Active Requirement lanes without a live claim after the recovery allowance.",
    unit: "count",
    comparator: "lte",
    target: 0,
    minimumSamples: 0,
    releaseBlocking: true,
    runbook: "#completion-and-stranded-lanes",
  },
  {
    id: "review_duration_p95",
    label: "Review duration p95",
    description: "Elapsed time for completed local and provider-aware review runs.",
    unit: "seconds",
    comparator: "lte",
    target: 1_800,
    minimumSamples: 2,
    releaseBlocking: true,
    runbook: "#review-and-merge-latency",
  },
  {
    id: "merge_latency_p95",
    label: "Merge latency p95",
    description: "Elapsed time from approved review evidence to confirmed repository merge.",
    unit: "seconds",
    comparator: "lte",
    target: 600,
    minimumSamples: 2,
    releaseBlocking: true,
    runbook: "#review-and-merge-latency",
  },
  {
    id: "recovery_time_p95",
    label: "Recovery time p95",
    description: "Elapsed time from the final retry attempt to successful delivery recovery.",
    unit: "seconds",
    comparator: "lte",
    target: 300,
    minimumSamples: 1,
    releaseBlocking: false,
    runbook: "#retry-and-recovery",
  },
];

function time(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[rank] ?? null;
}

function secondsBetween(start: Date | string, end: Date | string): number {
  return Math.max(0, (time(end) - time(start)) / 1_000);
}

function displayMetric(value: number | null, unit: DaemonSloObjective["unit"]): string {
  if (value === null) return "No data";
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "seconds") return value >= 60 ? `${(value / 60).toFixed(1)}m` : `${value.toFixed(1)}s`;
  return String(Math.round(value));
}

function buildMetric(
  objective: DaemonSloObjective,
  value: number | null,
  sampleCount: number,
): DaemonSloMetric {
  const hasData = objective.minimumSamples === 0 || sampleCount >= objective.minimumSamples;
  const satisfied = value !== null && (objective.comparator === "lte"
    ? value <= objective.target
    : value >= objective.target);
  return {
    ...objective,
    value,
    sampleCount,
    status: !hasData || value === null ? "no_data" : satisfied ? "pass" : "breach",
    displayValue: displayMetric(value, objective.unit),
  };
}

function approvedTimestamp(activity: DaemonSloSnapshot["activities"][number]): boolean {
  if (activity.action !== "status_changed") return false;
  const metadata = record(activity.metadata);
  return record(metadata.changes).status === "approved" || metadata.to === "approved";
}

export function buildDaemonSloReport(
  snapshot: DaemonSloSnapshot,
  windowHours: number,
  now = new Date(),
): DaemonSloReport {
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);
  const requirementsById = new Map(snapshot.requirements.map((requirement) => [requirement.id, requirement]));
  const approvalsByRequirement = new Map<string, number[]>();
  const claimsByRequirement = new Map<string, number[]>();
  for (const activity of snapshot.activities) {
    if (approvedTimestamp(activity)) {
      const values = approvalsByRequirement.get(activity.entityId) ?? [];
      values.push(time(activity.createdAt));
      approvalsByRequirement.set(activity.entityId, values);
    }
    if (activity.action === "claimed") {
      const values = claimsByRequirement.get(activity.entityId) ?? [];
      values.push(time(activity.createdAt));
      claimsByRequirement.set(activity.entityId, values);
    }
  }

  const acquisitionSeconds: number[] = [];
  for (const [requirementId, claimTimes] of claimsByRequirement) {
    const firstClaim = Math.min(...claimTimes);
    const approvedTimes = (approvalsByRequirement.get(requirementId) ?? []).filter((value) => value <= firstClaim);
    const requirement = requirementsById.get(requirementId);
    const eligibleAt = approvedTimes.length > 0
      ? Math.max(...approvedTimes)
      : requirement ? time(requirement.createdAt) : null;
    if (eligibleAt !== null && firstClaim >= eligibleAt) acquisitionSeconds.push((firstClaim - eligibleAt) / 1_000);
  }

  const recentlySeenThreshold = Math.max(windowStart.getTime(), now.getTime() - 5 * 60_000);
  const heartbeatGaps = snapshot.daemons
    .filter((daemon) => time(daemon.lastHeartbeatAt) >= recentlySeenThreshold)
    .map((daemon) => Math.max(0, (now.getTime() - time(daemon.lastHeartbeatAt)) / 1_000));

  const terminalRequirements = snapshot.requirements.filter((requirement) =>
    time(requirement.updatedAt) >= windowStart.getTime()
    && ["done", "cancelled"].includes(requirement.status),
  );
  const completionRate = terminalRequirements.length > 0
    ? terminalRequirements.filter((requirement) => requirement.status === "done").length / terminalRequirements.length
    : null;

  const retriedDeliveries = snapshot.deliveries.filter((delivery) =>
    delivery.retryCount > 0 && time(delivery.updatedAt) >= windowStart.getTime(),
  );
  const retryRecoveryRate = retriedDeliveries.length > 0
    ? retriedDeliveries.filter((delivery) => ["merged", "unchanged"].includes(delivery.deliveryStatus)).length
      / retriedDeliveries.length
    : null;

  const claimsByLane = new Map(snapshot.claims.map((claim) => [claim.requirementId, claim]));
  const strandedAllowanceMs = 5 * 60_000;
  const activeStatuses = new Set(["approved", "in_progress", "in_review", "ready_to_merge"]);
  const stranded = snapshot.requirements.filter((requirement) => {
    if (!activeStatuses.has(requirement.status)) return false;
    if (now.getTime() - time(requirement.updatedAt) <= strandedAllowanceMs) return false;
    const claim = claimsByLane.get(requirement.id);
    return !claim || time(claim.expiresAt) <= now.getTime();
  });

  const completedReviews = snapshot.reviewRuns.filter((run) =>
    run.completedAt && time(run.completedAt) >= windowStart.getTime(),
  );
  const reviewDurations = completedReviews.map((run) => secondsBetween(run.startedAt, run.completedAt!));
  const latestApprovedReview = new Map<string, number>();
  for (const run of completedReviews) {
    if (run.status !== "approved" || !run.completedAt) continue;
    latestApprovedReview.set(
      run.requirementRepositoryId,
      Math.max(latestApprovedReview.get(run.requirementRepositoryId) ?? 0, time(run.completedAt)),
    );
  }
  const mergeDurations = snapshot.deliveries.flatMap((delivery) => {
    if (!delivery.mergedAt || time(delivery.mergedAt) < windowStart.getTime()) return [];
    const reviewCompletedAt = latestApprovedReview.get(delivery.id);
    if (!reviewCompletedAt || time(delivery.mergedAt) < reviewCompletedAt) return [];
    return [(time(delivery.mergedAt) - reviewCompletedAt) / 1_000];
  });
  const recoveryDurations = retriedDeliveries.flatMap((delivery) =>
    delivery.mergedAt && delivery.lastAttemptAt && time(delivery.mergedAt) >= time(delivery.lastAttemptAt)
      ? [secondsBetween(delivery.lastAttemptAt, delivery.mergedAt)]
      : [],
  );

  const values: Record<DaemonSloMetricId, { value: number | null; samples: number }> = {
    acquisition_latency_p95: { value: percentile(acquisitionSeconds, 0.95), samples: acquisitionSeconds.length },
    heartbeat_gap_p99: { value: percentile(heartbeatGaps, 0.99), samples: heartbeatGaps.length },
    completion_rate: { value: completionRate, samples: terminalRequirements.length },
    retry_recovery_rate: { value: retryRecoveryRate, samples: retriedDeliveries.length },
    stranded_lanes: { value: stranded.length, samples: snapshot.requirements.length },
    review_duration_p95: { value: percentile(reviewDurations, 0.95), samples: reviewDurations.length },
    merge_latency_p95: { value: percentile(mergeDurations, 0.95), samples: mergeDurations.length },
    recovery_time_p95: { value: percentile(recoveryDurations, 0.95), samples: recoveryDurations.length },
  };
  const metrics = DAEMON_SLO_OBJECTIVES.map((objective) =>
    buildMetric(objective, values[objective.id].value, values[objective.id].samples),
  );
  const alerts = metrics.flatMap((metric): DaemonSloAlert[] => {
    if (metric.status === "pass" || (metric.status === "no_data" && !metric.releaseBlocking)) return [];
    const critical = metric.status === "breach" && (
      metric.id === "stranded_lanes"
      || metric.id === "heartbeat_gap_p99" && (metric.value ?? 0) > metric.target * 2
      || metric.id === "completion_rate" && (metric.value ?? 1) < 0.9
    );
    return [{
      id: `${metric.id}:${metric.status}`,
      metricId: metric.id,
      severity: critical ? "critical" : "warning",
      title: metric.status === "no_data" ? `${metric.label} lacks release evidence` : `${metric.label} breached`,
      summary: `${metric.displayValue}; target ${metric.comparator === "lte" ? "≤" : "≥"} ${displayMetric(metric.target, metric.unit)} (${metric.sampleCount} samples).`,
      runbook: metric.runbook,
    }];
  });

  return {
    generatedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    windowHours,
    releaseStatus: metrics.some((metric) =>
      metric.releaseBlocking && metric.status !== "pass",
    ) ? "blocked" : "pass",
    metrics,
    alerts,
    counts: {
      daemons: snapshot.daemons.length,
      requirements: snapshot.requirements.length,
      terminalRequirements: terminalRequirements.length,
      repositoryDeliveries: snapshot.deliveries.length,
    },
  };
}

export async function getDaemonSloReport(
  db: Database,
  query: DaemonSloQuery,
  now = new Date(),
): Promise<DaemonSloReport> {
  const windowStart = new Date(now.getTime() - query.windowHours * 3_600_000);
  const activeStatuses: Array<"approved" | "in_progress" | "in_review" | "ready_to_merge"> = [
    "approved",
    "in_progress",
    "in_review",
    "ready_to_merge",
  ];
  const [daemonRows, requirementRows, claimRows, activityRows, reviewRows, deliveryRows] = await Promise.all([
    db.select({
      id: daemons.id,
      status: daemons.status,
      lastHeartbeatAt: daemons.lastHeartbeatAt,
    }).from(daemons).where(gte(daemons.lastHeartbeatAt, windowStart)),
    db.select({
      id: requirements.id,
      status: requirements.status,
      createdAt: requirements.createdAt,
      updatedAt: requirements.updatedAt,
    }).from(requirements).where(or(
      gte(requirements.updatedAt, windowStart),
      inArray(requirements.status, activeStatuses),
    )),
    db.select({
      requirementId: requirementClaims.requirementId,
      expiresAt: requirementClaims.expiresAt,
      heartbeatAt: requirementClaims.heartbeatAt,
      createdAt: requirementClaims.createdAt,
    }).from(requirementClaims),
    db.select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      metadata: activityLog.metadata,
      createdAt: activityLog.createdAt,
    }).from(activityLog).where(and(
      gte(activityLog.createdAt, windowStart),
      inArray(activityLog.entityType, ["requirement", "daemon"]),
    )),
    db.select({
      requirementRepositoryId: reviewRuns.requirementRepositoryId,
      status: reviewRuns.status,
      startedAt: reviewRuns.startedAt,
      completedAt: reviewRuns.completedAt,
    }).from(reviewRuns).where(gte(reviewRuns.startedAt, windowStart)),
    db.select({
      id: requirementRepositories.id,
      requirementId: requirementRepositories.requirementId,
      deliveryStatus: requirementRepositories.deliveryStatus,
      retryCount: requirementRepositories.retryCount,
      lastAttemptAt: requirementRepositories.lastAttemptAt,
      mergedAt: requirementRepositories.mergedAt,
      updatedAt: requirementRepositories.updatedAt,
    }).from(requirementRepositories).where(or(
      gte(requirementRepositories.updatedAt, windowStart),
      inArray(requirementRepositories.deliveryStatus, ["failed", "in_review", "ready_to_merge"]),
    )),
  ]);
  return buildDaemonSloReport({
    daemons: daemonRows,
    requirements: requirementRows,
    claims: claimRows,
    activities: activityRows,
    reviewRuns: reviewRows,
    deliveries: deliveryRows,
  }, query.windowHours, now);
}
