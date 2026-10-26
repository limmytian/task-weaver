import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

type Page = { items: Array<{ id: string }>; total: number; pageCount: number; bytes: number };

/** Bound probe transfers before decoding; no response body is added to a receipt. */
export async function readPerformanceJson(response: Response, maximumBytes = 4 * 1024 * 1024) {
  const reader = response.body?.getReader();
  assert.ok(reader, "Performance probe response body unavailable");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= maximumBytes, "Performance probe response byte ceiling reached");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid JSON in performance probe"); }
  return { value, bytes };
}

/** Verify complete reachability, not just a fast first page, without retaining row contents. */
export async function verifyPerformancePagination(options: {
  expectedIds: readonly string[];
  readPage(page: number, signal: AbortSignal): Promise<Page>;
  pageSize?: number;
  maxDurationMs?: number;
}, timing = { now: () => performance.now(), wait: (milliseconds: number) => delay(milliseconds) }) {
  const pageSize = options.pageSize ?? 20;
  const duration = options.maxDurationMs ?? 60_000;
  assert.ok(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100);
  const expected = new Set(options.expectedIds);
  assert.equal(expected.size, options.expectedIds.length, "Fixture IDs must be unique");
  const pageCount = Math.max(1, Math.ceil(expected.size / pageSize));
  const seen = new Set<string>();
  const started = timing.now();
  let lastStarted = started - 100, maximumBytes = 0;
  const selectedPages = new Set([1, Math.ceil(pageCount / 2), pageCount]);
  const probes: Array<{ page: number; milliseconds: number; bytes: number; rows: number }> = [];
  for (let page = 1; page <= pageCount; page++) {
    await timing.wait(Math.max(0, lastStarted + 100 - timing.now()));
    const remaining = duration - (timing.now() - started);
    assert.ok(remaining > 0, "Pagination probe time ceiling reached");
    lastStarted = timing.now();
    const result = await options.readPage(page, AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(remaining)))));
    assert.equal(result.total, expected.size, "Pagination total changed or includes inaccessible rows");
    assert.equal(result.pageCount, Math.ceil(expected.size / pageSize), "Pagination page count is inconsistent");
    assert.equal(result.items.length, Math.min(pageSize, expected.size - (page - 1) * pageSize), "Pagination silently omitted rows");
    assert.ok(result.bytes <= 16 * 1024, "Summary page exceeded the synthetic payload ceiling");
    maximumBytes = Math.max(maximumBytes, result.bytes);
    for (const row of result.items) {
      assert.ok(expected.has(row.id), "Pagination returned an unauthorized or unexpected row");
      assert.ok(!seen.has(row.id), "Pagination repeated a row and made another unreachable");
      seen.add(row.id);
    }
    if (selectedPages.has(page)) probes.push({ page, milliseconds: timing.now() - lastStarted, bytes: result.bytes, rows: result.items.length });
  }
  assert.equal(seen.size, expected.size, "Pagination did not reach the complete fixture");
  return { expectedRows: expected.size, reachedRows: seen.size, requests: pageCount, elapsedMs: timing.now() - started, maximumBytes, probes };
}
