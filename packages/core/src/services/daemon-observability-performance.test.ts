import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { buildDaemonMetricsReport, type DaemonMetricsSnapshot } from "./daemon-metrics";

function burstFixture(): DaemonMetricsSnapshot {
  const daemons = Array.from({ length: 8 }, (_, daemonIndex) => ({
    id: `daemon-${daemonIndex}`,
    name: `executor-${daemonIndex}`,
    role: "executor",
    status: "busy",
    workerCapacity: 16,
    lastHeartbeatAt: "2026-08-13T17:59:30.000Z",
  }));
  const progress = daemons.flatMap((daemon) => Array.from({ length: 16 }, (_, workerIndex) => ({
    daemonId: daemon.id,
    workerIndex,
    phase: "executing",
    retryCount: 0,
    lastEventAt: "2026-08-13T17:59:30.000Z",
    updatedAt: "2026-08-13T17:59:30.000Z",
  })));
  const history = daemons.flatMap((daemon) => Array.from({ length: 16 }, (_, workerIndex) =>
    Array.from({ length: 100 }, (_, eventIndex) => ({
      id: `${daemon.id}-${workerIndex}-${eventIndex}`,
      daemonId: daemon.id,
      workerIndex,
      phase: eventIndex % 11 === 0 ? "recovering" : "executing",
      retryCount: eventIndex % 11 === 0 ? 1 : 0,
      occurredAt: new Date(Date.parse("2026-08-13T17:00:00.000Z") + eventIndex * 30_000).toISOString(),
    })),
  )).flat();
  return { asOf: new Date("2026-08-13T18:00:00.000Z"), daemons, progress, history, queue: [] };
}

test("multi-daemon progress bursts stay within metrics CPU and payload budgets", () => {
  const fixture = burstFixture();
  const started = performance.now();
  const report = buildDaemonMetricsReport(fixture, { windowHours: 1, bucketMinutes: 5 }, fixture.asOf);
  const elapsedMs = performance.now() - started;
  const payloadBytes = Buffer.byteLength(JSON.stringify(report), "utf8");

  assert.equal(report.sampleCount, 12_800);
  assert.equal(report.series.length, 9);
  assert.ok(elapsedMs < 1_500, `metrics projection took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(payloadBytes < 2_000_000, `metrics payload is ${payloadBytes} bytes`);
});
