import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Fixed arrivals with no backlog or retries: rejected offers remain visible in the receipt. */
export async function runPerformanceWave(options: {
  count: number;
  intervalMs: number;
  concurrency: number;
  request(index: number): Promise<unknown>;
}) {
  const { count, intervalMs, concurrency, request } = options;
  if (!Number.isInteger(count) || count < 1 || count > 10_000 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Invalid bounded workload");
  const started = performance.now();
  const successfulDurations: number[] = [];
  const inFlight = new Set<Promise<void>>();
  let skipped = 0, failures = 0, maximumInFlight = 0;
  for (let i = 0; i < count; i++) {
    await delay(Math.max(0, started + i * intervalMs - performance.now()));
    if (inFlight.size >= concurrency) { skipped++; continue; }
    const callStarted = performance.now();
    // Promise.resolve also captures a synchronous request failure without losing the arrival.
    const call = Promise.resolve().then(() => request(i)).then(
      () => { successfulDurations.push(performance.now() - callStarted); },
      () => { failures++; },
    );
    inFlight.add(call);
    maximumInFlight = Math.max(maximumInFlight, inFlight.size);
    void call.then(() => inFlight.delete(call));
  }
  await Promise.all(inFlight);
  return { offered: count, skipped, failures, successfulDurations, maximumInFlight, elapsedMs: performance.now() - started };
}
