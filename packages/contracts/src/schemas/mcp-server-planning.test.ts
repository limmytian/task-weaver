import test from "node:test";
import assert from "node:assert/strict";
import { mcpPlanApplySchema, mcpAggregateContextSchema, mcpDependencyGraphSchema } from "./mcp-server-planning";
const projectId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
test("planning rejects nested privilege escalation instead of stripping it", () => {
  const base = { projectId, requirements: [{ key: "r", title: "R", tasks: [{ key: "t", title: "T" }] }] };
  assert(mcpPlanApplySchema.safeParse({ plan: base, idempotencyKey }).success);
  for (const field of ["workflowPreset", "branchName", "daemonId", "leaseGeneration"]) {
    const plan = { ...base, requirements: [{ ...base.requirements[0], [field]: "unsafe" }] };
    assert(!mcpPlanApplySchema.safeParse({ plan, idempotencyKey }).success);
  }
  for (const field of ["requestedProvider", "requestedModel", "assignee", "force"]) {
    const plan = { ...base, requirements: [{ ...base.requirements[0], tasks: [{ key: "t", title: "T", [field]: "unsafe" }] }] };
    assert(!mcpPlanApplySchema.safeParse({ plan, idempotencyKey }).success);
  }
  assert(!mcpPlanApplySchema.safeParse({ plan: { projectId, documents: [{ key: "d", title: "D", content: "text", projectId: null }] }, idempotencyKey }).success);
});
test("planning preserves canonical required fields and caps aggregate work", () => {
  assert(!mcpPlanApplySchema.safeParse({ plan: { projectId, documents: [{ key: "d" }] }, idempotencyKey }).success);
  assert(!mcpPlanApplySchema.safeParse({ plan: { projectId }, idempotencyKey: "retry" }).success);
  assert(!mcpAggregateContextSchema.safeParse({ id: projectId, maxBytes: 1000000 }).success);
  assert(!mcpAggregateContextSchema.safeParse({ id: projectId, sections: ["secrets"] }).success);
});

test("dependency graphs reject unbounded traversal and client-supplied authority", () => {
  const input = { kind: "task", id: projectId };
  assert.ok(mcpDependencyGraphSchema.safeParse(input).success);
  for (const patch of [{ maxDepth: 5 }, { maxNodes: 51 }, { maxEdges: 101 }, { maxBytes: 32769 }, { actorId: "other" }, { includeHidden: true }]) assert.equal(mcpDependencyGraphSchema.safeParse({ ...input, ...patch }).success, false);
  assert.ok(mcpAggregateContextSchema.safeParse({ id: projectId, sections: ["comments", "notes"] }).success);
});
