import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServerArguments } from "./mcp-server-catalog";
const id = "11111111-1111-4111-8111-111111111111";
test("MCP preserves project membership and personal scope refinements", () => {
  assert.throws(() => parseMcpServerArguments("tw_tasks_create", { title: "Missing requirement", projectId: id }));
  assert.throws(() => parseMcpServerArguments("tw_tasks_create", { title: "Mixed scope", scope: "personal", projectId: id }));
  assert.throws(() => parseMcpServerArguments("tw_tasks_list", { scope: "personal", requirementId: id }));
  assert.throws(() => parseMcpServerArguments("tw_tasks_list", {}));
  assert.equal(parseMcpServerArguments("tw_tasks_create", { title: "Personal", scope: "personal" }).scope, "personal");
});
test("MCP omits privileged controls rather than silently accepting them", () => {
  for (const field of ["force", "daemonId", "leaseGeneration", "actorId"]) {
    assert.throws(() => parseMcpServerArguments("tw_tasks_status", { id, status: "done", [field]: true }));
  }
  assert.throws(() => parseMcpServerArguments("tw_requirements_update", { id, patch: { workflowPreset: "basic" } }));
  assert.throws(() => parseMcpServerArguments("tw_tasks_create", { title: "Spoof", scope: "personal", personalOwnerId: id }));
  assert.equal((parseMcpServerArguments("tw_tasks_update", { id, patch: { expectedVersion: 5 } }).patch as { expectedVersion: number }).expectedVersion, 5);
});
