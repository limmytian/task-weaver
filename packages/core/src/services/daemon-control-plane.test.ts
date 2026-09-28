import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDaemonQueueRequirement,
  type DaemonQueueRequirementInput,
} from "./daemon-control-plane";

const now = new Date("2026-07-24T08:00:00.000Z");
const daemons = [
  { role: "executor" as const, capabilities: ["executor:codex", "browser"] },
  { role: "reviewer" as const, capabilities: ["review"] },
  { role: "merger" as const, capabilities: ["merge"] },
];

function requirement(
  overrides: Partial<DaemonQueueRequirementInput> = {},
): DaemonQueueRequirementInput {
  return {
    id: "requirement-1",
    projectId: "project-1",
    projectName: "Task Weaver",
    title: "Ship the control plane",
    status: "approved",
    priority: "high",
    tags: [],
    updatedAt: now,
    tasks: [{
      id: "task-1",
      title: "Build queue view",
      status: "todo",
      tags: ["executor:codex", "capability:browser"],
      executionSliceId: "slice-1",
      dependencies: [],
    }],
    executionSlices: [{
      id: "slice-1",
      title: "Visibility",
      orderIndex: 0,
      allowParallel: false,
      status: "in_progress",
    }],
    dependencies: [],
    repositories: [],
    ...overrides,
  };
}

test("classifies the first eligible execution slice as runnable", () => {
  const item = classifyDaemonQueueRequirement(requirement(), daemons, now);

  assert.equal(item?.state, "runnable");
  assert.equal(item?.role, "executor");
  assert.equal(item?.taskId, "task-1");
  assert.equal(item?.executionSliceTitle, "Visibility");
});

test("reports dependency and slice-order blockers", () => {
  const dependencyBlocked = classifyDaemonQueueRequirement(requirement({
    dependencies: [{
      type: "blocks",
      dependsOn: { title: "Platform contract", status: "in_progress" },
    }],
  }), daemons, now);
  assert.deepEqual(dependencyBlocked?.reasonCodes, ["dependency"]);
  assert.match(dependencyBlocked?.reasons[0] ?? "", /Platform contract/);

  const sliceBlocked = classifyDaemonQueueRequirement(requirement({
    executionSlices: [
      {
        id: "slice-0",
        title: "Earlier",
        orderIndex: 0,
        allowParallel: false,
        status: "todo",
      },
      {
        id: "slice-1",
        title: "Visibility",
        orderIndex: 1,
        allowParallel: false,
        status: "todo",
      },
    ],
  }), daemons, now);
  assert.equal(sliceBlocked?.state, "blocked");
  assert.deepEqual(sliceBlocked?.reasonCodes, ["slice_order"]);
});

test("separates scheduled retries from operator-owned failures", () => {
  const retrying = classifyDaemonQueueRequirement(requirement({
    repositories: [{
      deliveryStatus: "failed",
      failureCode: "push_failed",
      failureSummary: "Remote was unavailable",
      retryCount: 2,
      retryRole: "executor",
      retryPolicy: "automatic",
      retryPhase: "execution",
      nextAttemptAt: "2026-07-24T08:05:00.000Z",
    }],
  }), daemons, now);
  assert.equal(retrying?.state, "retrying");
  assert.equal(retrying?.retryCount, 2);

  const manual = classifyDaemonQueueRequirement(requirement({
    repositories: [{
      deliveryStatus: "failed",
      failureCode: "auth_required",
      failureSummary: "Credentials need attention",
      retryCount: 1,
      retryRole: "executor",
      retryPolicy: "manual",
      retryPhase: "execution",
    }],
  }), daemons, now);
  assert.equal(manual?.state, "manual");
  assert.deepEqual(manual?.reasonCodes, ["policy"]);
  assert.equal(manual?.failureCode, "auth_required");
});

test("keeps follow-up retries in the target worker queue", () => {
  const item = classifyDaemonQueueRequirement(requirement({
    repositories: [{
      id: "link-1",
      repositoryId: "repository-1",
      repositoryName: "Task Weaver",
      repositoryKey: "git.example/task-weaver",
      deliveryStatus: "failed",
      failureCode: "review_changes_requested",
      failureSummary: "Address the review findings",
      retryCount: 1,
      retryRole: "executor",
      retryPolicy: "after_follow_up",
      retryPhase: "execution",
    }],
  }), daemons, now);

  assert.equal(item?.state, "runnable");
  assert.equal(item?.role, "executor");
  assert.equal(item?.repositories[0]?.linkId, "link-1");
});

test("routes review and merge work to their dedicated daemon roles", () => {
  const review = classifyDaemonQueueRequirement(requirement({
    status: "in_review",
    tasks: [],
    executionSlices: [],
  }), daemons, now);
  const merge = classifyDaemonQueueRequirement(requirement({
    status: "ready_to_merge",
    tasks: [],
    executionSlices: [],
  }), daemons, now);

  assert.equal(review?.state, "runnable");
  assert.equal(review?.role, "reviewer");
  assert.equal(merge?.state, "runnable");
  assert.equal(merge?.role, "merger");
});

test("surfaces manual merge requirements as operator actions with a provider URL", () => {
  const item = classifyDaemonQueueRequirement(requirement({
    status: "ready_to_merge",
    tasks: [],
    executionSlices: [],
    repositories: [{
      deliveryStatus: "ready_to_merge",
      retryCount: 0,
      mergeMode: "manual",
      manualActionUrl: "https://github.com/acme/app/pull/12",
    }],
  }), daemons, now);

  assert.equal(item?.state, "manual");
  assert.equal(item?.role, "operator");
  assert.deepEqual(item?.reasonCodes, ["manual_merge"]);
  assert.match(item?.reasons[0] ?? "", /pull\/12/);
});

test("reports missing executor capability instead of showing false readiness", () => {
  const item = classifyDaemonQueueRequirement(requirement(), [
    { role: "executor", capabilities: ["executor:agy"] },
  ], now);

  assert.equal(item?.state, "blocked");
  assert.deepEqual(item?.reasonCodes, ["capability"]);
});
