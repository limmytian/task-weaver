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
