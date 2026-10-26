import assert from "node:assert/strict";
import test from "node:test";
import { summarizePerformancePlan } from "./performance-query-plans";

test("plan receipts retain bounded numeric work and discard all expressions, literals and identities", () => {
  const result = summarizePerformancePlan([{ "Planning Time": .1, "Execution Time": 2,
    "Query Text": "private SQL", Plan: { "Node Type": "Limit", "Actual Rows": 20, "Actual Loops": 1,
      Filter: "private credential", "Relation Name": "private relation", Plans: [
        { "Node Type": "private unknown operator", "Actual Rows": 5000, "Shared Hit Blocks": 12, "Index Cond": "private identifier" },
      ] } }]);
  assert.deepEqual(result, { planningMs: .1, executionMs: 2, nodes: [
    { type: "Limit", depth: 0, counters: { "Actual Rows": 20, "Actual Loops": 1 } },
    { type: "Other", depth: 1, counters: { "Actual Rows": 5000, "Shared Hit Blocks": 12 } },
  ] });
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("malformed or unbounded plans fail closed without forwarding plan content", () => {
  for (const value of [null, [], [{ Plan: { "Actual Rows": "private" } }],
    [{ Plan: { "Actual Rows": -1 } }], [{ Plan: { "Actual Loops": Infinity } }],
    [{ "Planning Time": "private", "Execution Time": 0, Plan: {} }],
    [{ Plan: { Plans: Array.from({ length: 128 }, () => ({})) } }],
  ]) assert.throws(() => summarizePerformancePlan(value), error => !String(error).includes("private"));
});
