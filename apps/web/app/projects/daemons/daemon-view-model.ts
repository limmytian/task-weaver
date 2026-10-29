import type { DaemonRole } from "./control-plane";

export type DaemonRoadmapTask = {
  id: string;
  title: string;
  status: string;
};

export type DaemonWorkerView = {
  runId?: string | null;
  index: number;
  status: string;
  requirementId?: string | null;
  executionSliceId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  modelTier?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  worktreePath?: string | null;
  progressPhase?: string | null;
  leaseGeneration?: number | null;
  leaseHealthy?: boolean | null;
  leaseHeartbeatFailures?: number | null;
  lastLeaseError?: string | null;
  executionSlice?: { id: string; title: string } | null;
  progress?: {
    phase: string;
    message?: string | null;
    workspaceState?: string | null;
    recoveryDisposition?: string | null;
    retryCount?: number | null;
    handoffSummary?: string | null;
    lastEventAt?: Date | string | null;
  } | null;
  requirement?: {
    id: string;
    title: string;
    status: string;
    branchName?: string | null;
  } | null;
  roadmap?: DaemonRoadmapTask[];
  claim?: {
    expiresAt?: Date | string | null;
    heartbeatAt?: Date | string | null;
    generation?: number | null;
  } | null;
};

export type DaemonQueueView = {
  requirementId: string;
  projectId: string;
  projectName: string;
  title: string;
  requirementStatus: string;
  priority: string;
  role: DaemonRole | "operator";
  state: "runnable" | "blocked" | "retrying" | "manual";
  reasonCodes: string[];
  reasons: string[];
  taskId: string | null;
  taskTitle: string | null;
  executionSliceId: string | null;
  executionSliceTitle: string | null;
  retryCount: number;
  nextAttemptAt: Date | string | null;
  failureCode: string | null;
  failureSummary: string | null;
  repositories: Array<{
    linkId: string;
    repositoryId: string;
    repositoryName: string;
    repositoryKey: string;
    deliveryStatus: string;
    failureCode: string | null;
    failureSummary: string | null;
    retryCount: number;
    retryRole: DaemonRole | null;
    retryPolicy: "automatic" | "after_follow_up" | "manual" | null;
    retryExhausted: boolean;
    retryPhase: "execution" | "review" | "merge" | null;
    nextAttemptAt: Date | string | null;
  }>;
  updatedAt: Date | string;
};

export type OperatorAction =
  | {
      kind: "daemon";
      daemonId: string;
      daemonName: string;
      action: "pause" | "drain" | "resume";
    }
  | {
      kind: "pipeline";
      daemonIds: string[];
      pipelineName: string;
      action: "pause" | "drain" | "resume";
    }
  | {
      kind: "retry" | "handoff";
      linkId: string;
      repositoryName: string;
      retryRole: DaemonRole | null;
      retryPhase: "execution" | "review" | "merge" | null;
    };

export type TimelineRequirement = { id: string; title: string };
