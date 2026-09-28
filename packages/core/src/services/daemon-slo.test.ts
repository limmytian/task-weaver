import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonReleaseEvidence } from "./daemon-release-gate";
import { buildDaemonSloReport, type DaemonSloSnapshot } from "./daemon-slo";

const now = new Date("2026-07-24T10:00:00.000Z");

function passingSnapshot(): DaemonSloSnapshot {
  return {
    daemons: [
      { id: "executor", status: "idle", lastHeartbeatAt: "2026-07-24T09:59:30.000Z" },
      { id: "reviewer", status: "idle", lastHeartbeatAt: "2026-07-24T09:59:35.000Z" },
      { id: "merger", status: "idle", lastHeartbeatAt: "2026-07-24T09:59:40.000Z" },
    ],
    requirements: [
      { id: "req-1", status: "done", createdAt: "2026-07-24T09:00:00.000Z", updatedAt: "2026-07-24T09:20:00.000Z" },
      { id: "req-2", status: "done", createdAt: "2026-07-24T09:01:00.000Z", updatedAt: "2026-07-24T09:22:00.000Z" },
    ],
    claims: [],
    activities: [
      { entityId: "req-1", action: "status_changed", metadata: { changes: { status: "approved" } }, createdAt: "2026-07-24T09:00:00.000Z" },
      { entityId: "req-1", action: "claimed", metadata: {}, createdAt: "2026-07-24T09:00:10.000Z" },
      { entityId: "req-2", action: "status_changed", metadata: { changes: { status: "approved" } }, createdAt: "2026-07-24T09:01:00.000Z" },
      { entityId: "req-2", action: "claimed", metadata: {}, createdAt: "2026-07-24T09:01:20.000Z" },
    ],
    reviewRuns: [
      { requirementRepositoryId: "delivery-1", status: "approved", startedAt: "2026-07-24T09:10:00.000Z", completedAt: "2026-07-24T09:12:00.000Z" },
      { requirementRepositoryId: "delivery-2", status: "approved", startedAt: "2026-07-24T09:11:00.000Z", completedAt: "2026-07-24T09:13:00.000Z" },
    ],
    deliveries: [
      { id: "delivery-1", requirementId: "req-1", deliveryStatus: "merged", retryCount: 0, lastAttemptAt: "2026-07-24T09:13:00.000Z", mergedAt: "2026-07-24T09:15:00.000Z", updatedAt: "2026-07-24T09:15:00.000Z" },
      { id: "delivery-2", requirementId: "req-2", deliveryStatus: "merged", retryCount: 0, lastAttemptAt: "2026-07-24T09:14:00.000Z", mergedAt: "2026-07-24T09:16:00.000Z", updatedAt: "2026-07-24T09:16:00.000Z" },
    ],
  };
}

test("daemon SLO dashboard passes current acquisition, heartbeat, completion, review, and merge evidence", () => {
  const report = buildDaemonSloReport(passingSnapshot(), 24, now);
  const metrics = new Map(report.metrics.map((metric) => [metric.id, metric]));

  assert.equal(report.releaseStatus, "pass");
  assert.equal(metrics.get("acquisition_latency_p95")?.value, 20);
  assert.equal(metrics.get("heartbeat_gap_p99")?.value, 30);
  assert.equal(metrics.get("completion_rate")?.value, 1);
  assert.equal(metrics.get("stranded_lanes")?.value, 0);
  assert.equal(metrics.get("review_duration_p95")?.value, 120);
  assert.equal(metrics.get("merge_latency_p95")?.value, 180);
  assert.equal(metrics.get("retry_recovery_rate")?.status, "no_data");
  assert.deepEqual(report.alerts, []);
});

test("daemon SLO dashboard pages on heartbeat and stranded-lane regressions and blocks missing evidence", () => {
  const snapshot = passingSnapshot();
  snapshot.daemons[0]!.lastHeartbeatAt = "2026-07-24T09:57:00.000Z";
  snapshot.requirements.push({
    id: "req-stranded",
    status: "in_progress",
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:30:00.000Z",
  });

  const report = buildDaemonSloReport(snapshot, 24, now);

  assert.equal(report.releaseStatus, "blocked");
  assert.equal(report.metrics.find((metric) => metric.id === "stranded_lanes")?.status, "breach");
  assert.ok(report.alerts.some((alert) => alert.metricId === "heartbeat_gap_p99" && alert.severity === "critical"));
  assert.ok(report.alerts.some((alert) => alert.metricId === "stranded_lanes" && alert.severity === "critical"));
});

test("release evidence binds deterministic, real-forge, cleanup, and SLO invariants to one commit", () => {
  const slo = buildDaemonSloReport(passingSnapshot(), 24, now);
  const input = {
    commitSha: "abc1234",
    generatedAt: now.toISOString(),
    deterministicGate: { passed: true, command: "pnpm test:daemon-reliability" },
    realSmoke: {
      runId: "smoke-1",
      commitSha: "abc1234",
      completedAt: "2026-07-24T09:59:00.000Z",
      providers: ["github", "gitea"],
      requirementIds: ["req-1", "req-2"],
      repositoryKeys: ["github.com/acme/smoke", "git.example.test/acme/smoke"],
      approvals: 4,
      deliveries: 4,
      durationMs: 120_000,
      cleanedUp: true,
    },
    slo,
  };
  const ready = buildDaemonReleaseEvidence(input);
  assert.equal(ready.decision, "ready");
  assert.equal(ready.invariants.every((entry) => entry.passed), true);
  assert.match(ready.evidenceDigest, /^[0-9a-f]{64}$/);

  const blocked = buildDaemonReleaseEvidence({
    ...input,
    realSmoke: { ...input.realSmoke, commitSha: "different" },
  });
  assert.equal(blocked.decision, "blocked");
  assert.ok(blocked.blockers.some((blocker) => blocker.startsWith("real_ai_forges:")));
});
