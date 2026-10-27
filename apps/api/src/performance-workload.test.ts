import assert from "node:assert/strict";
import test from "node:test";
import { runPerformanceWave } from "./performance-workload";

test("saturated offers are counted without backlog or hidden retries", async () => {
  let active = 0, maximum = 0, calls = 0;
  let now = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = runPerformanceWave({ count: 20, intervalMs: 100, concurrency: 2, request: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await gate; active--;
  } }, { now: () => now, wait: async milliseconds => { now += milliseconds; } });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const result = await pending;
  assert.equal(maximum, 2);
  assert.equal(result.maximumInFlight, 2);
  assert.ok(result.skipped > 0);
  assert.equal(result.offered, result.skipped + calls);
  assert.equal(result.successfulDurations.length, calls);
  assert.equal(active, 0);
});

test("async and synchronous failures remain counted after leaving the active set", async () => {
  let now = 0;
  const result = await runPerformanceWave({ count: 6, intervalMs: 2, concurrency: 2, request: index => {
    if (index % 2) throw new Error("secret error must not be retained");
    return Promise.reject(new Error("private body"));
  } }, { now: () => now, wait: async milliseconds => { now += milliseconds; await new Promise(resolve => setImmediate(resolve)); } });
  assert.equal(result.failures, 6);
  assert.equal(result.skipped, 0);
  assert.equal(result.successfulDurations.length, 0);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("invalid workload bounds fail before any request", async () => {
  for (const concurrency of [0, 33, 1.5]) {
    await assert.rejects(runPerformanceWave({ concurrency, count: 1, intervalMs: 1, request: async () => assert.fail() }));
  }
});

test("event-loop stalls skip overdue arrivals instead of replaying a catch-up burst", async () => {
  let now = 0;
  const arrivals: number[] = [];
  const result = await runPerformanceWave({ count: 6, intervalMs: 100, concurrency: 1,
    request: async index => { arrivals.push(index); },
  }, {
    now: () => now,
    wait: async milliseconds => {
      now += milliseconds; if (now === 100) now = 450;
      await new Promise(resolve => setImmediate(resolve));
    },
  });
  assert.equal(result.lateOffers, 3);
  assert.deepEqual(arrivals, [0, 4, 5]);
  assert.equal(result.offered, result.skipped + result.failures + result.successfulDurations.length);
});
