import assert from "node:assert/strict";
import test from "node:test";
import { planPluginState } from "./plugin-state";

test("plugin state rejects read writes, stale recreation, namespace escape and quota overflow atomically", () => {
  const current = [{ key: "count", version: 3, value: 5, deleted: 0 }];
  const put = { result: 6, storageChanges: [{ key: "count", operation: "put", value: 6, expectedVersion: 3 }] };
  assert.throws(() => planPluginState(current, put, false));
  assert.equal(planPluginState(current, put, true).changes[0]?.version, 4);
  assert.equal(current[0]?.value, 5);
  const deleted = planPluginState(current, { result: null, storageChanges: [{ key: "count", operation: "delete", expectedVersion: 3 }] }, true).changes;
  assert.throws(() => planPluginState(deleted, { result: null, storageChanges: [{ key: "count", operation: "put", value: 1, expectedVersion: 0 }] }, true));
  assert.equal(planPluginState(deleted, { result: 1, storageChanges: [{ key: "count", operation: "put", value: 1, expectedVersion: 4 }] }, true).changes[0]?.version, 5);
  assert.throws(() => planPluginState([], { result: null, storageChanges: [{ key: "../other", operation: "put", value: 1, expectedVersion: 0 }] }, true));
  const full = Array.from({ length: 32 }, (_, i) => ({ key: `key${i}`, version: 1, value: null, deleted: 1 }));
  assert.throws(() => planPluginState(full, { result: null, storageChanges: [{ key: "extra", operation: "put", value: 1, expectedVersion: 0 }] }, true));
  const large = Array.from({ length: 5 }, (_, i) => ({ key: `key${i}`, version: 1, value: "x".repeat(14000), deleted: 0 }));
  assert.throws(() => planPluginState(large, { result: null }, false));
  assert.throws(() => planPluginState([], { result: null, coreSql: "SELECT 1" }, true));
});
