import { test } from "node:test";
import { strict as assert } from "node:assert";
import { assertPlanGraphAcyclic } from "./plans";

test("rejects a proposed cycle through live and new nodes", () => {
  const live = [{ from: "existing-a", to: "existing-b" }];
  const proposed = [{ from: "existing-b", to: "new:c" }, { from: "new:c", to: "existing-a" }];
  assert.throws(() => assertPlanGraphAcyclic(live, proposed, "task"), /cycle/);
});

test("accepts acyclic additions and rejects direct self dependencies", () => {
  assert.doesNotThrow(() => assertPlanGraphAcyclic([{ from: "a", to: "b" }], [{ from: "b", to: "c" }], "requirement"));
  assert.throws(() => assertPlanGraphAcyclic([], [{ from: "a", to: "a" }], "requirement"), /cycle/);
});

test("does not reject an unrelated legacy cycle and handles large graphs", () => {
  const live = [{ from: "legacy-a", to: "legacy-b" }, { from: "legacy-b", to: "legacy-a" }];
  for (let i = 0; i < 20000; i++) live.push({ from: `node-${i}`, to: `node-${i + 1}` });
  assert.doesNotThrow(() => assertPlanGraphAcyclic(live, [{ from: "new:x", to: "node-0" }], "task"));
  assert.throws(() => assertPlanGraphAcyclic(live, [{ from: "node-20000", to: "node-0" }], "task"), /cycle/);
});
