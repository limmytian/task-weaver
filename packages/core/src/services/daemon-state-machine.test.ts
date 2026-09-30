import assert from "node:assert";
import test from "node:test";
import { ValidationError } from "@task-weaver/contracts";
import { requirementStatusSchema } from "@task-weaver/contracts";
import {
  DAEMON_QUEUE_REQUIREMENT_STATUSES,
  MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS,
  assertRepositoryDeliveryStatusTransition,
  assertRequirementStatusTransition,
  canAcquireRepositoryRetry,
  canTransitionRepositoryDeliveryStatus,
  canTransitionRequirementStatus,
  classifyDaemonOutcome,
  daemonRoleForPhase,
  firstIncompleteRepositoryOperation,
  planRepositoryRetry,
  repositoryRetryBackoffMs,
  requirementStatusAfterTaskCreation,
  requirementStatePolicy,
} from "./daemon-state-machine";

test("requirement phases have one durable queue owner", () => {
  assert.deepEqual(DAEMON_QUEUE_REQUIREMENT_STATUSES, {
    executor: ["approved", "in_progress"],
    reviewer: ["in_review"],
    merger: ["ready_to_merge"],
  });
  assert.equal(requirementStatePolicy("approved").queueOwner, "executor");
  assert.equal(requirementStatePolicy("in_review").queueOwner, "reviewer");
  assert.equal(requirementStatePolicy("ready_to_merge").queueOwner, "merger");
  assert.equal(requirementStatePolicy("done").terminal, true);
});

test("every nonterminal requirement state has exactly one next actor", () => {
  for (const status of requirementStatusSchema.options) {
    const policy = requirementStatePolicy(status);
    if (policy.terminal) {
      assert.equal(policy.queueOwner, "none", `${status} must not remain serviceable`);
    } else {
      assert.notEqual(policy.queueOwner, "none", `${status} must have a next actor`);
    }
  }

  const daemonOwnedStatuses = Object.values(DAEMON_QUEUE_REQUIREMENT_STATUSES).flat();
  assert.deepEqual(
    [...daemonOwnedStatuses].sort(),
    ["approved", "in_progress", "in_review", "ready_to_merge"].sort(),
  );
});

test("requirement transitions allow the pipeline and explicit rework only", () => {
  assert.equal(canTransitionRequirementStatus("approved", "in_progress"), true);
  assert.equal(canTransitionRequirementStatus("in_progress", "in_review"), true);
  assert.equal(canTransitionRequirementStatus("in_review", "ready_to_merge"), true);
  assert.equal(canTransitionRequirementStatus("ready_to_merge", "done"), true);
  assert.equal(canTransitionRequirementStatus("in_review", "in_progress"), true);
  assert.equal(canTransitionRequirementStatus("done", "in_progress"), false);
  assert.throws(
    () => assertRequirementStatusTransition("cancelled", "approved"),
    ValidationError,
  );
});

test("repository delivery transitions preserve terminal outcomes", () => {
  assert.equal(canTransitionRepositoryDeliveryStatus("pending", "provisioning"), true);
  assert.equal(canTransitionRepositoryDeliveryStatus("pushing", "in_review"), true);
  assert.equal(canTransitionRepositoryDeliveryStatus("failed", "pending"), true);
  assert.equal(canTransitionRepositoryDeliveryStatus("merged", "failed"), false);
  assert.equal(canTransitionRepositoryDeliveryStatus("unchanged", "pushing"), false);
  assert.equal(canTransitionRepositoryDeliveryStatus("merged", "pending"), false);
  assert.equal(canTransitionRepositoryDeliveryStatus("merged", "pending", {
    allowTerminalReopen: true,
  }), true);
  assert.equal(canTransitionRepositoryDeliveryStatus("unchanged", "pending", {
    allowTerminalReopen: true,
  }), true);
  assert.equal(canTransitionRepositoryDeliveryStatus("merged", "provisioning", {
    allowTerminalReopen: true,
  }), false);
  assert.throws(
    () => assertRepositoryDeliveryStatusTransition("ready_to_merge", "pushing"),
    ValidationError,
  );
});

test("repository retry resumes at the first incomplete operation", () => {
  assert.equal(firstIncompleteRepositoryOperation({}, "push"), "push");
  assert.equal(firstIncompleteRepositoryOperation({
    clone: { status: "completed" },
    fetch: { status: "completed" },
    commit: { status: "failed" },
  }), "commit");
  assert.equal(firstIncompleteRepositoryOperation({
    clone: { status: "completed" },
    fetch: { status: "skipped" },
    commit: { status: "completed" },
    push: { status: "completed" },
    pull_request: { status: "failed" },
  }), "pull_request");
});

test("new open work explicitly requeues review and merge requirements", () => {
  assert.equal(requirementStatusAfterTaskCreation("in_review", "todo"), "in_progress");
  assert.equal(requirementStatusAfterTaskCreation("ready_to_merge", "in_review"), "in_progress");
  assert.equal(requirementStatusAfterTaskCreation("in_review", "done"), "in_review");
  assert.equal(requirementStatusAfterTaskCreation("approved", "todo"), "approved");
  assert.throws(
    () => requirementStatusAfterTaskCreation("done", "todo"),
    ValidationError,
  );
});

test("daemon outcomes route code findings and conflicts through follow-up work", () => {
  const finding = classifyDaemonOutcome("review_changes_requested", { currentPhase: "review" });
  assert.equal(finding.category, "code_finding");
  assert.equal(finding.retryPolicy, "after_follow_up");
  assert.equal(finding.targetPhase, "execution");
  assert.equal(finding.nextActor, "executor");
  assert.equal(finding.followUpTask, "required");

  const conflict = classifyDaemonOutcome("merge_conflict", { currentPhase: "merge" });
  assert.equal(conflict.category, "conflict");
  assert.equal(conflict.targetPhase, "execution");
  assert.equal(conflict.followUpTask, "required");
});

test("infrastructure faults retry in place without fake code tasks", () => {
  const outcome = classifyDaemonOutcome("git_fetch_failed", {
    currentPhase: "review",
    operation: "review",
  });
  assert.equal(outcome.category, "infrastructure");
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.retryPolicy, "automatic");
  assert.equal(outcome.targetPhase, "review");
  assert.equal(outcome.nextActor, "reviewer");
  assert.equal(outcome.followUpTask, "forbidden");
  assert.deepEqual(outcome.auditMetadata, {
    outcomeCode: "git_fetch_failed",
    outcomeCategory: "infrastructure",
    retryable: true,
    retryPolicy: "automatic",
    targetPhase: "review",
    nextActor: "reviewer",
    followUpTask: "forbidden",
    operation: "review",
  });
});

test("retry routing maps each active phase to one daemon role", () => {
  assert.equal(daemonRoleForPhase("execution"), "executor");
  assert.equal(daemonRoleForPhase("review"), "reviewer");
  assert.equal(daemonRoleForPhase("merge"), "merger");
  assert.throws(() => daemonRoleForPhase("terminal"), ValidationError);
});

test("repository retry backoff is exponential and bounded", () => {
  assert.equal(repositoryRetryBackoffMs(0), 30_000);
  assert.equal(repositoryRetryBackoffMs(1), 30_000);
  assert.equal(repositoryRetryBackoffMs(2), 60_000);
  assert.equal(repositoryRetryBackoffMs(8), 3_600_000);
  assert.equal(repositoryRetryBackoffMs(100), 3_600_000);
});

test("transient retries become explicit manual intervention after exhaustion", () => {
  const transient = planRepositoryRetry("automatic", 1);
  assert.deepEqual(transient, {
    attempt: 1,
    requestedPolicy: "automatic",
    effectivePolicy: "automatic",
    exhausted: false,
    delayMs: 30_000,
  });

  const exhausted = planRepositoryRetry("automatic", MAX_REPOSITORY_AUTO_RETRY_ATTEMPTS);
  assert.equal(exhausted.effectivePolicy, "manual");
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.delayMs, null);

  const policyBlock = planRepositoryRetry("manual", 1);
  assert.equal(policyBlock.effectivePolicy, "manual");
  assert.equal(policyBlock.exhausted, false);
  assert.equal(policyBlock.delayMs, null);
});

test("retry queues admit only the targeted role at the correct time", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(canAcquireRepositoryRetry({
    workerRole: "executor",
    retryRole: "executor",
    retryPolicy: "after_follow_up",
    nextAttemptAt: null,
    now,
  }), true);
  assert.equal(canAcquireRepositoryRetry({
    workerRole: "reviewer",
    retryRole: "reviewer",
    retryPolicy: "automatic",
    nextAttemptAt: new Date(now.getTime() - 1),
    now,
  }), true);
  assert.equal(canAcquireRepositoryRetry({
    workerRole: "reviewer",
    retryRole: "reviewer",
    retryPolicy: "automatic",
    nextAttemptAt: new Date(now.getTime() + 1),
    now,
  }), false);
  assert.equal(canAcquireRepositoryRetry({
    workerRole: "merger",
    retryRole: "merger",
    retryPolicy: "manual",
    nextAttemptAt: null,
    now,
  }), false);
  assert.equal(canAcquireRepositoryRetry({
    workerRole: "executor",
    retryRole: "reviewer",
    retryPolicy: "after_follow_up",
    nextAttemptAt: null,
    now,
  }), false);
});

test("every normalized outcome category remains serviceable from every active phase", () => {
  const cases = [
    ["review_changes_requested", "code_finding"],
    ["merge_conflict", "conflict"],
    ["git_fetch_failed", "infrastructure"],
    ["review_policy_unavailable", "policy"],
    ["agent_cancelled", "cancellation"],
    ["provider_new_failure", "unknown"],
  ] as const;
  const phases = ["execution", "review", "merge"] as const;
  const serviceablePhases = new Set<string>(phases);

  for (const phase of phases) {
    for (const [code, category] of cases) {
      const outcome = classifyDaemonOutcome(code, { currentPhase: phase });
      assert.equal(outcome.category, category, `${code} from ${phase}`);
      assert.equal(serviceablePhases.has(outcome.targetPhase), true);
      assert.notEqual(outcome.nextActor, "none");
      if (category === "code_finding" || category === "conflict") {
        assert.equal(outcome.targetPhase, "execution");
        assert.equal(outcome.nextActor, "executor");
        assert.equal(outcome.followUpTask, "required");
      } else if (category === "infrastructure" || category === "cancellation") {
        assert.equal(outcome.targetPhase, phase);
        assert.equal(outcome.nextActor, daemonRoleForPhase(phase));
        assert.equal(outcome.retryPolicy, "automatic");
        assert.equal(outcome.followUpTask, "forbidden");
      } else {
        assert.equal(outcome.targetPhase, phase);
        assert.equal(outcome.nextActor, "operator");
        assert.equal(outcome.retryPolicy, "manual");
        assert.equal(outcome.followUpTask, "forbidden");
      }
    }
  }
});

test("policy blocks and unknown failures fail closed for operator action", () => {
  const policy = classifyDaemonOutcome("forge_credential_unavailable", { currentPhase: "review" });
  assert.equal(policy.category, "policy");
  assert.equal(policy.retryable, false);
  assert.equal(policy.retryPolicy, "manual");
  assert.equal(policy.targetPhase, "review");
  assert.equal(policy.nextActor, "operator");
  assert.equal(policy.followUpTask, "forbidden");

  const credential = classifyDaemonOutcome("git_helper_unavailable", { currentPhase: "execution" });
  assert.equal(credential.category, "policy");
  assert.equal(credential.nextActor, "operator");

  const unknown = classifyDaemonOutcome("provider_new_failure", { currentPhase: "merge" });
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.targetPhase, "merge");
  assert.equal(unknown.nextActor, "operator");
});
