import assert from "node:assert/strict";
import test from "node:test";
import { macMemoryHeadroom, processSnapshot, processTree } from "./performance-resources.mjs";

test("macOS headroom includes reclaimable pages and fails closed on pressure or missing data", () => {
  const fixture = "page size of 16384 bytes\nPages free: 10000.\nPages inactive: 200000.\nPages speculative: 5000.";
  assert.equal(macMemoryHeadroom(fixture, "1\n"), 215000 * 16384);
  assert.throws(() => macMemoryHeadroom(fixture, "2"));
  assert.throws(() => macMemoryHeadroom(fixture, "4"));
  assert.throws(() => macMemoryHeadroom(fixture.replace("Pages free:", "Unknown:"), "1"));
});

test("numeric process accounting includes descendants without unrelated workloads", () => {
  const snapshot = processSnapshot(" 10 1 1024 1:02.50\n11 10 2048 0:01.25\n12 11 512 01:00:00\n99 1 999999 3:00.0\n");
  const selected = processTree(snapshot, 10);
  assert.deepEqual(selected.map(row => row.pid), [10, 11, 12]);
  assert.equal(selected.reduce((sum, row) => sum + row.rssBytes, 0), 3584 * 1024);
  assert.equal(selected[0].cpuSeconds, 62.5);
  assert.equal(selected[2].cpuSeconds, 3600);
  assert.throws(() => processSnapshot("10 1 invalid 0:00.1"));
});
