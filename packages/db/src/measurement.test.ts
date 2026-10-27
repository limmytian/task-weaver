import assert from "node:assert/strict";
import test from "node:test";
import { countDatabaseQuery, measureDatabaseWork, startDatabasePhase } from "./measurement";

test("measurement scopes isolate concurrent requests and never retain query arguments", async () => {
  const results = await Promise.all([1, 7].map(count => measureDatabaseWork(async () => {
    const finish = startDatabasePhase("identityLock");
    for (let i = 0; i < count; i++) countDatabaseQuery();
    await new Promise(resolve => setImmediate(resolve));
    finish(); finish();
    return "private body";
  })));
  assert.deepEqual(results.map(r => r.measurement.queryCount), [1, 7]);
  for (const { measurement } of results) {
    assert.equal(measurement.phases.identityLock.count, 1);
    assert.ok(measurement.phases.identityLock.milliseconds >= 0);
    assert.ok(!JSON.stringify(measurement).includes("private"));
  }
  countDatabaseQuery();
  const empty = await measureDatabaseWork(async () => undefined);
  assert.equal(empty.measurement.queryCount, 0);
});

test("failed and nested scopes do not contaminate subsequent measurements", async () => {
  await assert.rejects(measureDatabaseWork(async () => { countDatabaseQuery(); throw new Error("fixture"); }));
  const outer = await measureDatabaseWork(async () => {
    countDatabaseQuery();
    const inner = await measureDatabaseWork(async () => { countDatabaseQuery(); countDatabaseQuery(); });
    assert.equal(inner.measurement.queryCount, 2);
    countDatabaseQuery();
  });
  assert.equal(outer.measurement.queryCount, 2);
});
