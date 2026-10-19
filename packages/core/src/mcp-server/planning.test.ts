import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPlanJson } from "./planning";

test("plan retry hashes ignore object insertion order and undefined optional fields", () => {
  assert.equal(canonicalPlanJson({ b: [1, 2], a: { z: "text", c: undefined } }), canonicalPlanJson({ a: { z: "text" }, b: [1, 2] }));
  assert.notEqual(canonicalPlanJson({ tasks: [1, 2] }), canonicalPlanJson({ tasks: [2, 1] }));
  assert.equal(canonicalPlanJson({ date: new Date("2026-10-19T00:00:00.000Z") }), canonicalPlanJson({ date: "2026-10-19T00:00:00.000Z" }));
});
