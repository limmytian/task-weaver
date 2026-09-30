import { ValidationError } from "@task-weaver/contracts";
import { daemonOutcomeCodeSchema, daemonOutcomeSchema } from "@task-weaver/contracts";
import type {
  DaemonFollowUpPolicy,
  DaemonOutcome,
  DaemonOutcomeCategory,
  DaemonPhase,
  DaemonQueueOwner,
  DaemonRetryPolicy,
} from "@task-weaver/contracts";
import type { RequirementStatus } from "@task-weaver/contracts";
import type { RepositoryDeliveryOperation, RepositoryDeliveryStatus } from "@task-weaver/contracts";
import type { TaskStatus } from "@task-weaver/contracts";
import type { DaemonRole } from "@task-weaver/contracts";

export interface RequirementStatePolicy {
  phase: DaemonPhase;
  queueOwner: DaemonQueueOwner;
  terminal: boolean;
  allowedTransitions: readonly RequirementStatus[];
}

export const REQUIREMENT_STATE_POLICY: Readonly<Record<RequirementStatus, RequirementStatePolicy>> = {
  draft: {
    phase: "planning",
    queueOwner: "operator",
    terminal: false,
    allowedTransitions: ["draft", "approved", "cancelled", "archived"],
  },
  approved: {
    phase: "execution",
    queueOwner: "executor",
    terminal: false,
    allowedTransitions: ["approved", "in_progress", "in_review", "done", "cancelled", "archived"],
  },
  in_progress: {
    phase: "execution",
    queueOwner: "executor",
    terminal: false,
    allowedTransitions: ["approved", "in_progress", "in_review", "done", "cancelled", "archived"],
  },
  in_review: {
    phase: "review",
    queueOwner: "reviewer",
    terminal: false,
    allowedTransitions: ["in_review", "in_progress", "ready_to_merge", "done", "cancelled", "archived"],
  },
  ready_to_merge: {
    phase: "merge",
    queueOwner: "merger",
    terminal: false,
    allowedTransitions: ["ready_to_merge", "in_review", "in_progress", "done", "cancelled", "archived"],
  },
  done: {
    phase: "terminal",
    queueOwner: "none",
    terminal: true,
    allowedTransitions: ["done", "archived"],
  },
  cancelled: {
    phase: "terminal",
    queueOwner: "none",
    terminal: true,
    allowedTransitions: ["cancelled"],
  },
  archived: {
    phase: "terminal",
    queueOwner: "none",
    terminal: true,
    allowedTransitions: ["archived"],
  },
};

export const DAEMON_QUEUE_REQUIREMENT_STATUSES = {
  executor: ["approved", "in_progress"],
  reviewer: ["in_review"],
  merger: ["ready_to_merge"],
} as const satisfies Readonly<Record<"executor" | "reviewer" | "merger", readonly RequirementStatus[]>>;

export function requirementStatePolicy(status: RequirementStatus): RequirementStatePolicy {
  return REQUIREMENT_STATE_POLICY[status];
}

export function canTransitionRequirementStatus(from: RequirementStatus, to: RequirementStatus): boolean {
  return REQUIREMENT_STATE_POLICY[from].allowedTransitions.includes(to);
}

export function assertRequirementStatusTransition(from: RequirementStatus, to: RequirementStatus): void {
  if (!canTransitionRequirementStatus(from, to)) {
    throw new ValidationError(`Requirement status cannot transition from '${from}' to '${to}'`);
  }
}

export function requirementStatusAfterTaskCreation(
  requirementStatus: RequirementStatus,
  taskStatus: TaskStatus,
): RequirementStatus {
  const policy = requirementStatePolicy(requirementStatus);
  if (policy.terminal) {
    throw new ValidationError(`Cannot add tasks to a requirement with status '${requirementStatus}'`);
  }
  const taskIsOpen = taskStatus !== "done" && taskStatus !== "cancelled";
  if (taskIsOpen && (policy.phase === "review" || policy.phase === "merge")) {
    assertRequirementStatusTransition(requirementStatus, "in_progress");
    return "in_progress";
  }
  return requirementStatus;
}

export interface RepositoryDeliveryStatePolicy {
  phase: DaemonPhase;
  terminal: boolean;
  allowedTransitions: readonly RepositoryDeliveryStatus[];
}

export const REPOSITORY_DELIVERY_STATE_POLICY: Readonly<
  Record<RepositoryDeliveryStatus, RepositoryDeliveryStatePolicy>
> = {
  pending: { phase: "execution", terminal: false, allowedTransitions: ["pending", "provisioning", "failed"] },
  provisioning: { phase: "execution", terminal: false, allowedTransitions: ["provisioning", "ready", "failed"] },
  ready: { phase: "execution", terminal: false, allowedTransitions: ["ready", "changed", "pushing", "failed"] },
  changed: { phase: "execution", terminal: false, allowedTransitions: ["changed", "pushing", "failed"] },
  pushing: {
    phase: "execution",
    terminal: false,
    allowedTransitions: ["pushing", "pushed", "in_review", "unchanged", "failed"],
  },
  pushed: {
    phase: "review",
    terminal: false,
    allowedTransitions: ["pushed", "in_review", "ready_to_merge", "merged", "failed"],
  },
  in_review: {
    phase: "review",
    terminal: false,
    allowedTransitions: ["in_review", "ready_to_merge", "merged", "failed"],
  },
  ready_to_merge: {
    phase: "merge",
    terminal: false,
    allowedTransitions: ["in_review", "ready_to_merge", "merged", "failed"],
  },
  merged: { phase: "terminal", terminal: true, allowedTransitions: ["merged"] },
  unchanged: { phase: "terminal", terminal: true, allowedTransitions: ["unchanged"] },
  failed: {
    phase: "execution",
    terminal: false,
    allowedTransitions: [
      "failed",
      "pending",
      "provisioning",
      "ready",
      "pushing",
      "in_review",
      "ready_to_merge",
      "merged",
    ],
  },
};

export function canTransitionRepositoryDeliveryStatus(
  from: RepositoryDeliveryStatus,
  to: RepositoryDeliveryStatus,
  options: { allowTerminalReopen?: boolean } = {},
): boolean {
  if (
    options.allowTerminalReopen
    && REPOSITORY_DELIVERY_STATE_POLICY[from].terminal
    && to === "pending"
  ) {
    return true;
  }
  return REPOSITORY_DELIVERY_STATE_POLICY[from].allowedTransitions.includes(to);
}

export function assertRepositoryDeliveryStatusTransition(
  from: RepositoryDeliveryStatus,
  to: RepositoryDeliveryStatus,
  options: { allowTerminalReopen?: boolean } = {},
): void {
  if (!canTransitionRepositoryDeliveryStatus(from, to, options)) {
    throw new ValidationError(`Repository delivery cannot transition from '${from}' to '${to}'`);
  }
}

export function isTerminalRepositoryDeliveryStatus(status: string): boolean {
  return status === "merged" || status === "unchanged";
}

export const REPOSITORY_OPERATION_ORDER = [
  "clone",
  "fetch",
  "commit",
  "push",
  "pull_request",
  "review",
  "merge",
] as const satisfies readonly RepositoryDeliveryOperation[];

export function firstIncompleteRepositoryOperation(
  checkpoints: Record<string, { status?: string }> | null | undefined,
  fallback?: string | null,
): RepositoryDeliveryOperation {
  if (!checkpoints || Object.keys(checkpoints).length === 0) {
    return fallback && REPOSITORY_OPERATION_ORDER.includes(fallback as RepositoryDeliveryOperation)
      ? fallback as RepositoryDeliveryOperation
      : "clone";
  }
  const firstIncomplete = REPOSITORY_OPERATION_ORDER.find((operation) => {
    const status = checkpoints?.[operation]?.status;
    return status !== "completed" && status !== "skipped";
  });
  if (firstIncomplete) return firstIncomplete;
  if (fallback && REPOSITORY_OPERATION_ORDER.includes(fallback as RepositoryDeliveryOperation)) {
    return fallback as RepositoryDeliveryOperation;
  }
  return "clone";
}

interface OutcomeTemplate {
  category: DaemonOutcomeCategory;
  retryPolicy: DaemonRetryPolicy;
  targetPhase?: DaemonPhase;
  nextActor?: DaemonQueueOwner;
  followUpTask: DaemonFollowUpPolicy;
  operatorMessage: string;
}

const CODE_FINDING: OutcomeTemplate = {
  category: "code_finding",
  retryPolicy: "after_follow_up",
  targetPhase: "execution",
  nextActor: "executor",
  followUpTask: "required",
  operatorMessage: "Create a concrete follow-up task and return the requirement to execution.",
};

const CONFLICT: OutcomeTemplate = {
  category: "conflict",
  retryPolicy: "after_follow_up",
  targetPhase: "execution",
  nextActor: "executor",
  followUpTask: "required",
  operatorMessage: "Create a conflict-resolution task and return the requirement to execution.",
};

const INFRASTRUCTURE: OutcomeTemplate = {
  category: "infrastructure",
  retryPolicy: "automatic",
  followUpTask: "forbidden",
  operatorMessage: "Keep the requirement in its current phase and retry the failed operation with bounded backoff.",
};

const POLICY: OutcomeTemplate = {
  category: "policy",
  retryPolicy: "manual",
  nextActor: "operator",
  followUpTask: "forbidden",
  operatorMessage: "Keep the requirement in its current phase and request explicit operator remediation.",
};

const CANCELLATION: OutcomeTemplate = {
  category: "cancellation",
  retryPolicy: "automatic",
  followUpTask: "forbidden",
  operatorMessage: "Preserve durable progress and retry the interrupted operation in the current phase.",
};

const UNKNOWN: OutcomeTemplate = {
  category: "unknown",
  retryPolicy: "manual",
  nextActor: "operator",
  followUpTask: "forbidden",
  operatorMessage: "The outcome is not classified; keep the current phase and require operator triage.",
};

function outcomeTemplate(code: string): OutcomeTemplate {
  if (
    code === "review_changes_requested"
    || code === "review_check_failed"
    || code === "ai_review_changes_requested"
    || code === "code_finding"
  ) return CODE_FINDING;

  if (code === "review_conflict" || code === "merge_conflict" || code === "base_merge_conflict") {
    return CONFLICT;
  }

  if (code.includes("response_lost")) return INFRASTRUCTURE;

  if (
    code.includes("credential")
    || code.includes("policy")
    || code.includes("denied")
    || code.includes("not_verified")
    || code.includes("endpoint_missing")
    || code.includes("profile_")
    || code.includes("git_helper")
    || code.includes("keychain")
    || code.includes("ssh_agent")
    || code.includes("_mismatch")
    || code.includes("_dirty")
    || code === "explicit_consent_required"
    || code === "review_skipped"
    || code === "merge_skipped"
  ) return POLICY;

  if (code.includes("cancelled") || code.includes("canceled") || code === "lease_lost") {
    return CANCELLATION;
  }

  if (
    code.startsWith("git_")
    || code.startsWith("forge_")
    || code.startsWith("review_")
    || code.startsWith("merge_")
    || code.startsWith("agent_")
    || code.startsWith("ai_")
    || code.startsWith("workspace_")
    || code.startsWith("finalization_")
    || code.startsWith("remote_")
    || code.endsWith("_timeout")
    || code.endsWith("_failed")
    || code.endsWith("_unavailable")
  ) return INFRASTRUCTURE;

  return UNKNOWN;
}

function queueOwnerForPhase(phase: DaemonPhase): DaemonQueueOwner {
  if (phase === "execution") return "executor";
  if (phase === "review") return "reviewer";
  if (phase === "merge") return "merger";
  if (phase === "terminal") return "none";
  return "operator";
}

export function daemonRoleForPhase(phase: DaemonPhase): DaemonRole {
  if (phase === "execution") return "executor";
  if (phase === "review") return "reviewer";
  if (phase === "merge") return "merger";
  throw new ValidationError(`Daemon phase '${phase}' does not have a retry worker`);
}

export function repositoryRetryBackoffMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(Math.trunc(attempt), 8));
  return Math.min(30_000 * (2 ** (boundedAttempt - 1)), 3_600_000);
}

export const MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS = 8;

export interface RepositoryRetryPlan {
  attempt: number;
  requestedPolicy: DaemonRetryPolicy;
  effectivePolicy: DaemonRetryPolicy;
  exhausted: boolean;
  delayMs: number | null;
}

export function planRepositoryRetry(
  requestedPolicy: DaemonRetryPolicy,
  attempt: number,
): RepositoryRetryPlan {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  const exhausted = requestedPolicy === "automatic"
    && normalizedAttempt >= MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS;
  const effectivePolicy = exhausted ? "manual" : requestedPolicy;
  return {
    attempt: normalizedAttempt,
    requestedPolicy,
    effectivePolicy,
    exhausted,
    delayMs: effectivePolicy === "automatic"
      ? repositoryRetryBackoffMs(normalizedAttempt)
      : null,
  };
}

export function canAcquireRepositoryRetry(input: {
  workerRole: DaemonRole;
  retryRole: DaemonRole | null;
  retryPolicy: DaemonRetryPolicy | null;
  nextAttemptAt: Date | null;
  now?: Date;
}): boolean {
  if (input.retryRole !== input.workerRole) return false;
  if (input.retryPolicy === "after_follow_up") return true;
  if (input.retryPolicy !== "automatic" || !input.nextAttemptAt) return false;
  return input.nextAttemptAt <= (input.now ?? new Date());
}

export function classifyDaemonOutcome(
  rawCode: string,
  context: { currentPhase?: DaemonPhase; operation?: string } = {},
): DaemonOutcome {
  const code = daemonOutcomeCodeSchema.parse(rawCode);
  const template = outcomeTemplate(code);
  const currentPhase = context.currentPhase && context.currentPhase !== "planning" && context.currentPhase !== "terminal"
    ? context.currentPhase
    : "execution";
  const targetPhase = template.targetPhase ?? currentPhase;
  const nextActor = template.nextActor ?? queueOwnerForPhase(targetPhase);
  const retryable = template.retryPolicy === "automatic" || template.retryPolicy === "after_follow_up";

  return daemonOutcomeSchema.parse({
    code,
    category: template.category,
    retryable,
    retryPolicy: template.retryPolicy,
    targetPhase,
    nextActor,
    followUpTask: template.followUpTask,
    operatorMessage: template.operatorMessage,
    auditMetadata: {
      outcomeCode: code,
      outcomeCategory: template.category,
      retryable,
      retryPolicy: template.retryPolicy,
      targetPhase,
      nextActor,
      followUpTask: template.followUpTask,
      operation: context.operation ?? null,
    },
  });
}
