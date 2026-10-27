import assert from "node:assert/strict";
import test from "node:test";
import { readPerformanceJson, verifyPerformancePagination } from "./performance-pagination";

function fixture(corrupt?: "duplicate" | "foreign" | "count" | "truncate") {
  let now = 0;
  const ids = Array.from({ length: 45 }, (_, i) => `row-${i}`);
  const starts: number[] = [];
  return { ids, starts, timing: { now: () => now, wait: async (milliseconds: number) => { now += milliseconds; } },
    readPage: async (page: number) => {
      starts.push(now);
      const items = ids.slice((page - 1) * 20, page * 20).map(id => ({ id }));
      if (page === 2 && corrupt === "duplicate") items[0] = { id: ids[0]! };
      if (page === 2 && corrupt === "foreign") items[0] = { id: "private-other-project" };
      if (page === 2 && corrupt === "truncate") items.pop();
      return { items, total: corrupt === "count" ? 46 : 45, pageCount: 3, bytes: 1000 };
    } };
}

test("pagination checks first, deep and partial last pages with bounded arrivals", async () => {
  const f = fixture();
  const result = await verifyPerformancePagination({ expectedIds: f.ids, readPage: f.readPage }, f.timing);
  assert.equal(result.reachedRows, 45); assert.equal(result.requests, 3);
  assert.deepEqual(result.probes.map(p => p.rows), [20, 20, 5]);
  assert.deepEqual(f.starts, [0, 100, 200]);
  assert.ok(!JSON.stringify(result).includes("row-"));
});

test("probe decoding stops oversized responses before assembling or exposing their body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("private synthetic body")); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readPerformanceJson(response, 4), /response byte ceiling/);
  assert.equal(cancelled, true);
  const result = await readPerformanceJson(new Response('{"total":5}'));
  assert.deepEqual(result, { value: { total: 5 }, bytes: 11 });
});

test("duplicates, unauthorized rows, false totals and silent truncation fail the probe", async () => {
  for (const corrupt of ["duplicate", "foreign", "count", "truncate"] as const) {
    const f = fixture(corrupt);
    await assert.rejects(verifyPerformancePagination({ expectedIds: f.ids, readPage: f.readPage }, f.timing));
  }
});
