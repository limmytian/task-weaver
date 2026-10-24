import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { inputJsonSchema } from "./json-schema";
import { assistantContextLimitsSchema } from "./schemas/assistant";
import { updateInboundSourceSchema } from "./schemas/inbound-events";
import { updateScheduleSchema } from "./schemas/schedules";
import { schedulerEligibilityDiagnosticsSchema } from "./schemas/daemons";

// Size bounds must reject hostile collections without walking invalid elements.
test("bounded collections reject oversized inputs before element validation", () => {
  let visited = 0;
  const element = z.string().superRefine(() => { visited++; });
  for (const schema of [z.array(element).max(2), z.array(element).length(2)]) {
    const result = schema.safeParse(Array(10_000).fill("invalid"));
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues.length, 1);
  }
  assert.equal(visited, 0);
  let keysVisited = 0;
  const key = z.string().superRefine(() => { keysVisited++; });
  assert.equal(z.set(key).max(2).safeParse(new Set(["a", "b", "c"])).success, false);
  assert.equal(z.map(key, element).max(2).safeParse(new Map([["a", "a"], ["b", "b"], ["c", "c"]])).success, false);
  assert.equal(keysVisited, 0);
  assert.equal(visited, 0);
});

test("partial updates preserve omitted fields and nested creation defaults still parse", () => {
  assert.deepEqual(updateScheduleSchema.parse({ title: "Rename only" }), { title: "Rename only" });
  assert.deepEqual(updateInboundSourceSchema.parse({ name: "Rename only" }), { name: "Rename only" });
  const defaults = assistantContextLimitsSchema.parse(undefined);
  assert.equal(defaults.recentActivity, 10);
  assert.equal(defaults.textChars, 1200);
});

test("scheduler diagnostics accept sparse enum-key counts", () => {
  assert.deepEqual(schedulerEligibilityDiagnosticsSchema.parse({ candidateCount: 1, examinedCount: 1, runnableCount: 1, selectedCount: 1, truncated: false, skipCounts: {}, samples: [] }).skipCounts, {});
});

test("tool input JSON Schema retains date formats, optional defaults and strict fields", () => {
  const schema = inputJsonSchema(z.object({
    when: z.coerce.date<Date>().optional(),
    count: z.number().int().max(10).default(2),
    query: z.string().trim().min(1),
  }).strict());
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["query"]);
  assert.deepEqual(schema.properties?.when, { type: "string", format: "date-time" });
  const count = schema.properties?.count;
  assert.ok(count && typeof count === "object");
  assert.equal(count.maximum, 10);
  assert.throws(() => inputJsonSchema(z.object({ secret: z.custom() })), /represented/);
});
