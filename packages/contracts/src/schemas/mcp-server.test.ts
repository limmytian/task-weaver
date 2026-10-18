import assert from "node:assert/strict";
import test from "node:test";
import { isMcpServerToolAllowed, mcpServerPageSchema, mcpServerToolErrorSchema } from "./mcp-server";

test("read-only dispatch rejects known writes and arbitrary executors", () => {
  assert.equal(isMcpServerToolAllowed("tw_tasks_status", true), false);
  assert.equal(isMcpServerToolAllowed("tw_tasks_status", false), true);
  assert.equal(isMcpServerToolAllowed("tw_tasks_get", true), true);
  for (const name of ["tw_mcp_call", "tw_daemon_start", "request", "__proto__", "toString"]) {
    assert.equal(isMcpServerToolAllowed(name, false), false);
  }
});

test("MCP pagination is bounded and does not silently coerce malformed inputs", () => {
  assert.deepEqual(mcpServerPageSchema.parse({}), { page: 1, pageSize: 20 });
  for (const input of [
    { page: 0 }, { page: 1.5 }, { pageSize: 51 }, { pageSize: "20" },
    { pageSize: 0 }, { page: 1, actorId: "spoofed" },
  ]) assert.equal(mcpServerPageSchema.safeParse(input).success, false);
});

test("tool errors have a bounded public envelope without arbitrary upstream details", () => {
  const error = { ok: false, error: { code: "version_conflict", message: "Read the current version before updating." } };
  assert.deepEqual(mcpServerToolErrorSchema.parse(error), error);
  assert.equal(mcpServerToolErrorSchema.safeParse({ ...error, authorization: "secret" }).success, false);
  assert.equal(mcpServerToolErrorSchema.safeParse({ ok: false, error: { ...error.error, stack: "private" } }).success, false);
  assert.equal(mcpServerToolErrorSchema.safeParse({ ok: false, error: { code: "upstream_error", message: "x".repeat(1001) } }).success, false);
});
