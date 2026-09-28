import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonTimeline } from "./daemon-timeline";

test("correlates progress, task, review, retry, and delivery events newest first", () => {
  const events = buildDaemonTimeline({
    progress: [{
      id: "progress-1",
      occurredAt: "2026-07-24T08:00:00.000Z",
      role: "executor",
      phase: "executing",
      message: "Running the control-plane tests",
      source: "daemon",
      runId: "run-1",
      workerIndex: 0,
      currentTaskId: "task-1",
      executionSliceId: "slice-1",
      workspaceState: "dirty",
      recoveryDisposition: "none",
      retryCount: 0,
      leaseGeneration: 3,
    }],
    taskStatuses: [{
      id: "status-1",
      taskId: "task-1",
      fromStatus: "in_progress",
      toStatus: "done",
      reason: "Checks passed",
      changedBy: "agent-1",
      changedByType: "agent",
      createdAt: "2026-07-24T08:01:00.000Z",
    }],
    activities: [{
      id: "activity-1",
      action: "repository_delivery_updated",
      actorId: "reviewer-1",
      actorType: "agent",
      createdAt: "2026-07-24T08:02:00.000Z",
      metadata: {
        repositoryId: "repository-1",
        reviewStatus: "approved",
        reviewPolicyDecision: "satisfied",
      },
    }, {
      id: "activity-2",
      action: "repository_delivery_retry_requested",
      actorId: "operator-1",
      actorType: "human",
      createdAt: "2026-07-24T07:59:00.000Z",
      metadata: {
        repositoryId: "repository-1",
        retryRole: "reviewer",
        reason: "Transient provider failure cleared",
      },
    }],
    repositories: [{
      id: "link-1",
      repositoryId: "repository-1",
      repositoryName: "Task Weaver",
      deliveryStatus: "merged",
      pushStatus: "pushed",
      reviewStatus: "approved",
      mergeStatus: "merged",
      retryCount: 1,
      pullRequestUrl: "https://git.example/pr/42",
      updatedAt: "2026-07-24T08:03:00.000Z",
    }],
    taskTitles: { "task-1": "Build the timeline" },
    sliceTitles: { "slice-1": "Interaction quality" },
    repositoryNames: { "repository-1": "Task Weaver" },
    limit: 20,
  });

  assert.deepEqual(events.map((event) => event.kind), [
    "merge",
    "review",
    "task",
    "progress",
    "retry",
  ]);
  assert.equal(events[0]?.pullRequestUrl, "https://git.example/pr/42");
  assert.equal(events[1]?.repositoryName, "Task Weaver");
  assert.equal(events[2]?.taskTitle, "Build the timeline");
  assert.equal(events[3]?.executionSliceTitle, "Interaction quality");
});

test("bounds large timelines after deterministic sorting", () => {
  const events = buildDaemonTimeline({
    progress: Array.from({ length: 250 }, (_, index) => ({
      id: `progress-${index}`,
      occurredAt: new Date(Date.UTC(2026, 6, 24, 8, 0, index)).toISOString(),
      role: "executor",
      phase: "executing",
      message: `event ${index}`,
      source: "daemon",
      runId: "run-1",
      workerIndex: 0,
      leaseGeneration: 1,
    })),
    taskStatuses: [],
    activities: [],
    repositories: [],
    taskTitles: {},
    sliceTitles: {},
    repositoryNames: {},
    limit: 100,
  });

  assert.equal(events.length, 100);
  assert.equal(events[0]?.summary, "event 249");
  assert.equal(events.at(-1)?.summary, "event 150");
});

