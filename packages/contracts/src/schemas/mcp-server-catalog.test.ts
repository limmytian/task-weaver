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

test("MCP memory saves require explicit intent, retry keys and consistent scope", () => {
  const save = { title: "Handoff", content: "Continue from verified state", projectId: id, confirmed: true, idempotencyKey: id };
  assert.equal(parseMcpServerArguments("tw_memories_record", save).scope, "project");
  for (const invalid of [
    { ...save, confirmed: false }, { ...save, idempotencyKey: undefined },
    { ...save, scope: "personal" }, { ...save, personalOwnerId: id },
    { ...save, scope: "global" }, { ...save, metadata: { trusted: true } },
  ]) assert.throws(() => parseMcpServerArguments("tw_memories_record", invalid));
  assert.throws(() => parseMcpServerArguments("tw_memories_update", { id, patch: { content: "Changed" } }));
  assert.throws(() => parseMcpServerArguments("tw_memories_forget", { id, confirmed: true }));
});

test("plugin calls pin revisions and explicit retry intent without accepting worker configuration", () => {
  const request = { installationId: id, method: "increment", input: {}, expectedRevision: 1, idempotencyKey: id, confirmed: true };
  assert.equal(parseMcpServerArguments("tw_plugins_call", request).expectedRevision, 1);
  for (const patch of [{ confirmed: false }, { expectedRevision: undefined }, { idempotencyKey: undefined }, { profile: {} }, { personalOwnerId: id }, { method: "__tw_preflight" }, { input: "x".repeat(16385) }]) {
    assert.throws(() => parseMcpServerArguments("tw_plugins_call", { ...request, ...patch }));
  }
  for (const invalid of [{ scope: "project" }, { scope: "personal", projectId: id }, { scope: "global", projectId: id }, { limit: 21 }]) assert.throws(() => parseMcpServerArguments("tw_plugins_list", invalid));
});
