import { matchDaemonTaskCapabilities } from "./daemon-capabilities";
import { MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS } from "./daemon-state-machine";

export type DaemonControlPlaneRole = "executor" | "reviewer" | "merger";
export type DaemonQueueState = "runnable" | "blocked" | "retrying" | "manual";

export interface DaemonQueueDaemonInput {
  role: DaemonControlPlaneRole;
  capabilities: string[];
}

export interface DaemonQueueDependencyInput {
  type: string;
  dependsOn?: {
    title: string;
    status: string;
  } | null;
}

export interface DaemonQueueSliceInput {
  id: string;
  title: string;
  orderIndex: number;
  allowParallel: boolean;
  status: string;
}

export interface DaemonQueueTaskInput {
  id: string;
  title: string;
  status: string;
  tags?: string[] | null;
  executionSliceId?: string | null;
  dependencies?: DaemonQueueDependencyInput[];
}

export interface DaemonQueueRepositoryInput {
  id?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryKey?: string;
  deliveryStatus: string;
  failureCode?: string | null;
  failureSummary?: string | null;
  retryCount: number;
  retryRole?: DaemonControlPlaneRole | null;
  retryPolicy?: "automatic" | "after_follow_up" | "manual" | null;
  retryPhase?: "execution" | "review" | "merge" | null;
  nextAttemptAt?: Date | string | null;
  mergeMode?: "provider" | "direct" | "manual" | null;
  manualActionUrl?: string | null;
}

export interface DaemonQueueRequirementInput {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: string;
  tags?: string[] | null;
  updatedAt: Date | string;
  claim?: {
    claimedBy: string;
    expiresAt: Date | string;
    generation: number;
  } | null;
  dependencies?: DaemonQueueDependencyInput[];
  executionSlices?: DaemonQueueSliceInput[];
  tasks?: DaemonQueueTaskInput[];
  repositories?: DaemonQueueRepositoryInput[];
}

export interface DaemonQueueItem {
  requirementId: string;
  projectId: string;
  projectName: string;
  title: string;
  requirementStatus: string;
  priority: string;
  role: DaemonControlPlaneRole | "operator";
  state: DaemonQueueState;
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
    retryRole: DaemonControlPlaneRole | null;
    retryPolicy: "automatic" | "after_follow_up" | "manual" | null;
    retryExhausted: boolean;
    retryPhase: "execution" | "review" | "merge" | null;
    nextAttemptAt: Date | string | null;
    mergeMode: "provider" | "direct" | "manual" | null;
    manualActionUrl: string | null;
  }>;
  updatedAt: Date | string;
}

function roleForStatus(status: string): DaemonControlPlaneRole | null {
  if (status === "approved" || status === "in_progress") return "executor";
  if (status === "in_review") return "reviewer";
  if (status === "ready_to_merge") return "merger";
  return null;
}

function unfinished(status: string | undefined) {
  return status !== "done" && status !== "cancelled" && status !== "archived";
}

function queueItem(
  requirement: DaemonQueueRequirementInput,
  role: DaemonQueueItem["role"],
  state: DaemonQueueState,
  reasonCodes: string[],
  reasons: string[],
  task?: DaemonQueueTaskInput | null,
  slice?: DaemonQueueSliceInput | null,
  repository?: DaemonQueueRepositoryInput | null,
): DaemonQueueItem {
  return {
    requirementId: requirement.id,
    projectId: requirement.projectId,
    projectName: requirement.projectName,
    title: requirement.title,
    requirementStatus: requirement.status,
    priority: requirement.priority,
    role,
    state,
    reasonCodes,
    reasons,
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null,
    executionSliceId: slice?.id ?? null,
    executionSliceTitle: slice?.title ?? null,
    retryCount: repository?.retryCount ?? 0,
    nextAttemptAt: repository?.nextAttemptAt ?? null,
    failureCode: repository?.failureCode ?? null,
    failureSummary: repository?.failureSummary ?? null,
    repositories: (requirement.repositories ?? []).map((entry) => ({
      linkId: entry.id ?? "",
      repositoryId: entry.repositoryId ?? "",
      repositoryName: entry.repositoryName ?? "Repository",
      repositoryKey: entry.repositoryKey ?? "",
      deliveryStatus: entry.deliveryStatus,
      failureCode: entry.failureCode ?? null,
      failureSummary: entry.failureSummary ?? null,
      retryCount: entry.retryCount,
      retryRole: entry.retryRole ?? null,
      retryPolicy: entry.retryPolicy ?? null,
      retryExhausted: entry.retryPolicy === "manual"
        && entry.retryCount >= MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS,
      retryPhase: entry.retryPhase ?? null,
      nextAttemptAt: entry.nextAttemptAt ?? null,
      mergeMode: entry.mergeMode ?? null,
      manualActionUrl: entry.manualActionUrl ?? null,
    })),
    updatedAt: requirement.updatedAt,
  };
}

function taskSlice(
  task: DaemonQueueTaskInput | undefined,
  slices: DaemonQueueSliceInput[],
) {
  return task?.executionSliceId
    ? slices.find((slice) => slice.id === task.executionSliceId) ?? null
    : null;
}

function roleHasCapability(
  role: DaemonControlPlaneRole,
  tags: string[],
  daemons: DaemonQueueDaemonInput[],
) {
  const candidates = daemons.filter((daemon) => daemon.role === role);
  if (role === "executor") {
    return candidates.some((daemon) =>
      matchDaemonTaskCapabilities(tags, daemon.capabilities).eligible,
    );
  }

  const requiredTools = tags
    .filter((tag) => tag.startsWith("tool:"))
    .map((tag) => tag.slice(5));
  return candidates.some((daemon) =>
    requiredTools.length === 0
      || requiredTools.some((tool) => daemon.capabilities.includes(tool)),
  );
}

export function classifyDaemonQueueRequirement(
  requirement: DaemonQueueRequirementInput,
  daemons: DaemonQueueDaemonInput[],
  now = new Date(),
): DaemonQueueItem | null {
  if (!unfinished(requirement.status)) return null;

  const role = roleForStatus(requirement.status);
  const manualMerge = (requirement.repositories ?? []).find(
    (repository) => repository.deliveryStatus === "ready_to_merge" && repository.mergeMode === "manual",
  );
  if (manualMerge) {
    return queueItem(
      requirement,
      "operator",
      "manual",
      ["manual_merge"],
      [manualMerge.manualActionUrl
        ? `Manual merge is ready at ${manualMerge.manualActionUrl}`
        : "Manual merge is ready but no provider action URL is available"],
      null,
      null,
      manualMerge,
    );
  }
  const failedRepositories = (requirement.repositories ?? []).filter(
    (repository) => repository.deliveryStatus === "failed",
  );

  const manualFailure = failedRepositories.find((repository) =>
    !role
    || repository.retryRole !== role
    || repository.retryPolicy === null
    || repository.retryPolicy === undefined
    || repository.retryPolicy === "manual",
  );
  if (manualFailure) {
    const phase = manualFailure.retryPhase ?? "delivery";
    return queueItem(
      requirement,
      manualFailure.retryRole ?? role ?? "operator",
      "manual",
      ["policy"],
      [manualFailure.failureSummary ?? `${phase} failure requires operator follow-up`],
      null,
      null,
      manualFailure,
    );
  }

  const delayedRetry = failedRepositories.find((repository) => {
    if (repository.retryPolicy !== "automatic" || repository.retryRole !== role) return false;
    if (!repository.nextAttemptAt) return true;
    return new Date(repository.nextAttemptAt).getTime() > now.getTime();
  });
  if (delayedRetry) {
    return queueItem(
      requirement,
      role ?? "operator",
      "retrying",
      ["retry_time"],
      [delayedRetry.nextAttemptAt
        ? `Automatic retry is scheduled for ${new Date(delayedRetry.nextAttemptAt).toISOString()}`
        : "Automatic retry is waiting for a retry schedule"],
      null,
      null,
      delayedRetry,
    );
  }

  if (!role) {
    return queueItem(
      requirement,
      "operator",
      "manual",
      ["status"],
      [`Requirement status '${requirement.status}' is not owned by a daemon role`],
    );
  }

  if (requirement.claim && new Date(requirement.claim.expiresAt).getTime() > now.getTime()) {
    return queueItem(
      requirement,
      role,
      "blocked",
      ["claim"],
      [`Claimed by ${requirement.claim.claimedBy} (lease ${requirement.claim.generation})`],
    );
  }

  const blockingRequirements = (requirement.dependencies ?? []).filter((dependency) =>
    dependency.type === "blocks" && unfinished(dependency.dependsOn?.status),
  );
  if (blockingRequirements.length > 0) {
    return queueItem(
      requirement,
      role,
      "blocked",
      ["dependency"],
      blockingRequirements.map((dependency) =>
        `Waiting for ${dependency.dependsOn?.title ?? "an unfinished requirement"}`,
      ),
    );
  }

  const roleDaemons = daemons.filter((daemon) => daemon.role === role);
  if (roleDaemons.length === 0) {
    return queueItem(
      requirement,
      role,
      "blocked",
      ["capability"],
      [`No online ${role} daemon is available`],
    );
  }

  if (role !== "executor") {
    if (!roleHasCapability(role, requirement.tags ?? [], daemons)) {
      return queueItem(
        requirement,
        role,
        "blocked",
        ["capability"],
        [`No online ${role} daemon satisfies the required tools`],
      );
    }
    return queueItem(requirement, role, "runnable", [], [`Ready for ${role}`]);
  }

  const slices = requirement.executionSlices ?? [];
  const activeSlices = slices.filter((slice) => unfinished(slice.status));
  const pendingTasks = (requirement.tasks ?? []).filter((task) => task.status === "todo");
  if (pendingTasks.length === 0) {
    return queueItem(
      requirement,
      role,
      "blocked",
      ["status"],
      ["No pending task is available for execution"],
    );
  }

  const structurallyRunnable: DaemonQueueTaskInput[] = [];
  const blockedReasonCodes = new Set<string>();
  const blockedReasons = new Set<string>();
  for (const task of pendingTasks) {
    const taskBlockers = (task.dependencies ?? []).filter((dependency) =>
      dependency.type === "blocks" && dependency.dependsOn?.status !== "done",
    );
    if (taskBlockers.length > 0) {
      blockedReasonCodes.add("dependency");
      for (const dependency of taskBlockers) {
        blockedReasons.add(`Task waits for ${dependency.dependsOn?.title ?? "an unfinished task"}`);
      }
      continue;
    }

    const slice = taskSlice(task, slices);
    const sliceBlocked = slice
      ? !unfinished(slice.status)
        || (!slice.allowParallel && activeSlices.some((candidate) =>
          candidate.orderIndex < slice.orderIndex,
        ))
      : activeSlices.length > 0;
    if (sliceBlocked) {
      blockedReasonCodes.add("slice_order");
      blockedReasons.add("Waiting for an earlier execution slice");
      continue;
    }
    structurallyRunnable.push(task);
  }

  if (structurallyRunnable.length === 0) {
    const task = pendingTasks[0];
    return queueItem(
      requirement,
      role,
      "blocked",
      [...blockedReasonCodes],
      [...blockedReasons],
      task,
      taskSlice(task, slices),
    );
  }

  const runnableTask = structurallyRunnable.find((task) =>
    roleHasCapability(role, task.tags ?? [], daemons),
  );
  if (!runnableTask) {
    const task = structurallyRunnable[0];
    return queueItem(
      requirement,
      role,
      "blocked",
      ["capability"],
      ["No online executor satisfies this task's executor and capability tags"],
      task,
      taskSlice(task, slices),
    );
  }

  return queueItem(
    requirement,
    role,
    "runnable",
    [],
    ["Ready for execution"],
    runnableTask,
    taskSlice(runnableTask, slices),
  );
}
