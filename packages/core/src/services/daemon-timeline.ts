export type DaemonTimelineKind = "progress" | "task" | "delivery" | "review" | "merge" | "retry" | "control";

export interface DaemonTimelineEvent {
  id: string;
  occurredAt: Date | string;
  kind: DaemonTimelineKind;
  title: string;
  summary: string | null;
  status: string | null;
  actor: string | null;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  executionSliceId: string | null;
  executionSliceTitle: string | null;
  repositoryId: string | null;
  repositoryName: string | null;
  pullRequestUrl: string | null;
  details: Record<string, unknown>;
}

interface TimelineProgressInput {
  id: string;
  occurredAt: Date | string;
  role: string;
  phase: string;
  message?: string | null;
  source: string;
  runId: string;
  workerIndex: number;
  currentTaskId?: string | null;
  executionSliceId?: string | null;
  workspaceState?: string | null;
  recoveryDisposition?: string | null;
  retryCount?: number | null;
  pendingDiffSummary?: string | null;
  sliceSummary?: string | null;
  handoffSummary?: string | null;
  leaseGeneration: number;
  details?: Record<string, unknown> | null;
}

interface TimelineTaskStatusInput {
  id: string;
  taskId: string;
  fromStatus?: string | null;
  toStatus: string;
  reason?: string | null;
  changedBy: string;
  changedByType: string;
  createdAt: Date | string;
}

interface TimelineActivityInput {
  id: string;
  action: string;
  actorId: string;
  actorType: string;
  metadata?: unknown;
  createdAt: Date | string;
}

interface TimelineRepositoryInput {
  id: string;
  repositoryId: string;
  repositoryName: string;
  deliveryStatus: string;
  pushStatus: string;
  reviewStatus: string;
  mergeStatus: string;
  failureCode?: string | null;
  failureSummary?: string | null;
  retryCount: number;
  retryPhase?: string | null;
  retryRole?: string | null;
  retryPolicy?: string | null;
  resumeOperation?: string | null;
  nextAttemptAt?: Date | string | null;
  pullRequestUrl?: string | null;
  mergeMode?: string | null;
  manualActionUrl?: string | null;
  externalSyncRevision?: number | null;
  externalStateUpdatedAt?: Date | string | null;
  headCommit?: string | null;
  pushedCommit?: string | null;
  updatedAt: Date | string;
}

export interface BuildDaemonTimelineInput {
  progress: TimelineProgressInput[];
  taskStatuses: TimelineTaskStatusInput[];
  activities: TimelineActivityInput[];
  repositories: TimelineRepositoryInput[];
  taskTitles: Record<string, string>;
  sliceTitles: Record<string, string>;
  repositoryNames: Record<string, string>;
  limit: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activityKind(action: string, metadata: Record<string, unknown>): DaemonTimelineKind {
  if (action.includes("retry")) return "retry";
  if (action.includes("control")) return "control";
  if (action.includes("merge") || metadata.mergeStatus) return "merge";
  if (action.includes("review") || metadata.reviewStatus || metadata.reviewPolicyDecision) return "review";
  return "delivery";
}

function activityTitle(action: string, metadata: Record<string, unknown>) {
  if (action === "repository_forge_state_synchronized") {
    return `Forge pull request ${String(metadata.pullRequestState ?? "synchronized")}`;
  }
  if (action === "repository_delivery_updated") {
    if (metadata.mergeStatus) return `Merge ${String(metadata.mergeStatus)}`;
    if (metadata.reviewStatus) return `Review ${String(metadata.reviewStatus)}`;
    if (metadata.pushStatus) return `Push ${String(metadata.pushStatus)}`;
    return `Delivery ${String(metadata.deliveryStatus ?? "updated")}`;
  }
  return action.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function activitySummary(metadata: Record<string, unknown>) {
  return stringValue(metadata.reason)
    ?? stringValue(metadata.failureSummary)
    ?? stringValue(metadata.summary)
    ?? stringValue(metadata.operatorMessage);
}

export function buildDaemonTimeline(input: BuildDaemonTimelineInput): DaemonTimelineEvent[] {
  const progressEvents: DaemonTimelineEvent[] = input.progress.map((progress) => ({
    id: `progress:${progress.id}`,
    occurredAt: progress.occurredAt,
    kind: "progress",
    title: `${progress.role} · ${progress.phase}`,
    summary: progress.message ?? progress.handoffSummary ?? progress.sliceSummary ?? null,
    status: progress.phase,
    actor: progress.source,
    runId: progress.runId,
    taskId: progress.currentTaskId ?? null,
    taskTitle: progress.currentTaskId ? input.taskTitles[progress.currentTaskId] ?? null : null,
    executionSliceId: progress.executionSliceId ?? null,
    executionSliceTitle: progress.executionSliceId
      ? input.sliceTitles[progress.executionSliceId] ?? null
      : null,
    repositoryId: null,
    repositoryName: null,
    pullRequestUrl: null,
    details: {
      source: progress.source,
      workerIndex: progress.workerIndex,
      workspaceState: progress.workspaceState ?? "unknown",
      recoveryDisposition: progress.recoveryDisposition ?? "none",
      retryCount: progress.retryCount ?? 0,
      pendingDiffSummary: progress.pendingDiffSummary ?? null,
      sliceSummary: progress.sliceSummary ?? null,
      handoffSummary: progress.handoffSummary ?? null,
      leaseGeneration: progress.leaseGeneration,
      ...(progress.details ?? {}),
    },
  }));

  const taskEvents: DaemonTimelineEvent[] = input.taskStatuses.map((status) => ({
    id: `task:${status.id}`,
    occurredAt: status.createdAt,
    kind: "task",
    title: `Task moved to ${status.toStatus}`,
    summary: status.reason ?? null,
    status: status.toStatus,
    actor: `${status.changedByType}:${status.changedBy}`,
    runId: null,
    taskId: status.taskId,
    taskTitle: input.taskTitles[status.taskId] ?? null,
    executionSliceId: null,
    executionSliceTitle: null,
    repositoryId: null,
    repositoryName: null,
    pullRequestUrl: null,
    details: { fromStatus: status.fromStatus ?? null, toStatus: status.toStatus },
  }));

  const activityEvents: DaemonTimelineEvent[] = input.activities.map((activity) => {
    const metadata = record(activity.metadata);
    const repositoryId = stringValue(metadata.repositoryId);
    return {
      id: `activity:${activity.id}`,
      occurredAt: activity.createdAt,
      kind: activityKind(activity.action, metadata),
      title: activityTitle(activity.action, metadata),
      summary: activitySummary(metadata),
      status: stringValue(metadata.deliveryStatus)
        ?? stringValue(metadata.reviewStatus)
        ?? stringValue(metadata.mergeStatus),
      actor: `${activity.actorType}:${activity.actorId}`,
      runId: stringValue(metadata.runId),
      taskId: stringValue(metadata.taskId),
      taskTitle: stringValue(metadata.taskId)
        ? input.taskTitles[String(metadata.taskId)] ?? null
        : null,
      executionSliceId: stringValue(metadata.executionSliceId),
      executionSliceTitle: stringValue(metadata.executionSliceId)
        ? input.sliceTitles[String(metadata.executionSliceId)] ?? null
        : null,
      repositoryId,
      repositoryName: repositoryId ? input.repositoryNames[repositoryId] ?? null : null,
      pullRequestUrl: stringValue(metadata.pullRequestUrl),
      details: metadata,
    };
  });

  const repositoryEvents: DaemonTimelineEvent[] = input.repositories.map((repository) => ({
    id: `repository:${repository.id}`,
    occurredAt: repository.updatedAt,
    kind: repository.mergeStatus === "merged"
      ? "merge"
      : repository.reviewStatus !== "pending"
        ? "review"
        : repository.retryPolicy
          ? "retry"
          : "delivery",
    title: `${repository.repositoryName} delivery snapshot`,
    summary: repository.failureSummary ?? null,
    status: repository.deliveryStatus,
    actor: "system:snapshot",
    runId: null,
    taskId: null,
    taskTitle: null,
    executionSliceId: null,
    executionSliceTitle: null,
    repositoryId: repository.repositoryId,
    repositoryName: repository.repositoryName,
    pullRequestUrl: repository.pullRequestUrl ?? null,
    details: {
      pushStatus: repository.pushStatus,
      reviewStatus: repository.reviewStatus,
      mergeStatus: repository.mergeStatus,
      failureCode: repository.failureCode ?? null,
      retryCount: repository.retryCount,
      retryPhase: repository.retryPhase ?? null,
      retryRole: repository.retryRole ?? null,
      retryPolicy: repository.retryPolicy ?? null,
      resumeOperation: repository.resumeOperation ?? null,
      nextAttemptAt: repository.nextAttemptAt ?? null,
      headCommit: repository.headCommit ?? null,
      pushedCommit: repository.pushedCommit ?? null,
      mergeMode: repository.mergeMode ?? null,
      manualActionUrl: repository.manualActionUrl ?? null,
      externalSyncRevision: repository.externalSyncRevision ?? 0,
      externalStateUpdatedAt: repository.externalStateUpdatedAt ?? null,
    },
  }));

  return [...progressEvents, ...taskEvents, ...activityEvents, ...repositoryEvents]
    .sort((left, right) =>
      new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()
      || left.id.localeCompare(right.id),
    )
    .slice(0, input.limit);
}
