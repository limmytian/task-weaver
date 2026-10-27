import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Fixed arrivals with no backlog or retries: rejected offers remain visible in the receipt. */
export async function runPerformanceWave(options: {
  count: number;
  intervalMs: number;
  concurrency: number;
  request(index: number): Promise<unknown>;
}, timing = { now: () => performance.now(), wait: (milliseconds: number) => delay(milliseconds) }) {
  const { count, intervalMs, concurrency, request } = options;
  if (!Number.isInteger(count) || count < 1 || count > 10_000 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Invalid bounded workload");
  const started = timing.now();
  const successfulDurations: number[] = [];
  const inFlight = new Set<Promise<void>>();
  let skipped = 0, lateOffers = 0, failures = 0, maximumInFlight = 0;
  for (let i = 0; i < count; i++) {
    const due = started + i * intervalMs;
    await timing.wait(Math.max(0, due - timing.now()));
    // A stalled generator cannot catch up by sending a burst of overdue arrivals.
    if (timing.now() - due >= intervalMs) { skipped++; lateOffers++; continue; }
    if (inFlight.size >= concurrency) { skipped++; continue; }
    const callStarted = timing.now();
    // Promise.resolve also captures a synchronous request failure without losing the arrival.
    const call = Promise.resolve().then(() => request(i)).then(
      () => { successfulDurations.push(timing.now() - callStarted); },
      () => { failures++; },
    );
    inFlight.add(call);
    maximumInFlight = Math.max(maximumInFlight, inFlight.size);
    void call.then(() => inFlight.delete(call));
  }
  await timing.wait(Math.max(0, started + count * intervalMs - timing.now()));
  await Promise.all(inFlight);
  return { offered: count, skipped, lateOffers, failures, successfulDurations, maximumInFlight, elapsedMs: timing.now() - started };
}
