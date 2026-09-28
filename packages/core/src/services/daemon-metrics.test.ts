import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonMetricsReport, type DaemonMetricsSnapshot } from "./daemon-metrics";

const now = new Date("2026-08-13T18:00:00.000Z");

function snapshot(): DaemonMetricsSnapshot {
  return {
    asOf: now,
    daemons: [{
      id: "00000000-0000-4000-8000-000000000001",
      name: "executor-1",
      role: "executor",
      status: "idle",
      workerCapacity: 2,
      lastHeartbeatAt: "2026-08-13T17:59:00.000Z",
    }],
    progress: [{
      daemonId: "00000000-0000-4000-8000-000000000001",
      workerIndex: 0,
      phase: "recovering",
      retryCount: 3,
      lastEventAt: "2026-08-13T17:58:00.000Z",
      updatedAt: "2026-08-13T17:58:00.000Z",
    }],
    history: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        daemonId: "00000000-0000-4000-8000-000000000001",
        workerIndex: 0,
        phase: "recovering",
        retryCount: 3,
        occurredAt: "2026-08-13T17:58:00.000Z",
      },
    ],
    queue: [{ state: "manual", reasonCodes: ["policy"], retryCount: 3, repositories: [{ retryExhausted: true }] }],
  };
}

test("builds bounded per-daemon and aggregate time-series metrics", () => {
  const report = buildDaemonMetricsReport(snapshot(), { windowHours: 1, bucketMinutes: 30 }, now);
  assert.equal(report.noData, false);
  assert.equal(report.sampleCount, 1);
  assert.equal(report.series.length, 2);
  assert.equal(report.series[1]?.points.length, 2);
  assert.equal(report.series[1]?.points[1]?.values.retryEvents, 1);
  assert.ok(report.alerts.some((alert) => alert.code === "retry_exhaustion"));
  assert.ok(report.alerts.some((alert) => alert.code === "manual_handoff"));
});

test("explicitly reports no-data windows without inventing samples", () => {
  const empty = snapshot();
  empty.history = [];
  const report = buildDaemonMetricsReport(empty, { windowHours: 1, bucketMinutes: 60 }, now);
  assert.equal(report.noData, true);
  assert.equal(report.sampleCount, 0);
  assert.ok(report.series[0]?.points.every((point) => point.sampleCount === 0));
});
