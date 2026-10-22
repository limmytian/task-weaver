import assert from "node:assert/strict";
import test from "node:test";
import { requireMcpInput, McpInputValidationError } from "./mcp-input-validation";

test("MCP input validation rejects missing, extra and malformed fields before dispatch", () => {
  const schema = { type: "object", properties: { key: { type: "string", enum: ["proof"] } }, required: ["key"], additionalProperties: false };
  assert.throws(() => requireMcpInput(schema, undefined), McpInputValidationError);
  assert.throws(() => requireMcpInput(schema, { key: "wrong" }), McpInputValidationError);
  assert.throws(() => requireMcpInput(schema, { key: "proof", secret: "not-reflected" }), error => error instanceof McpInputValidationError && !error.message.includes("not-reflected"));
  requireMcpInput(schema, { key: "proof" });
});

test("separate MCP schemas cannot poison each other's validators through a shared $id", () => {
  requireMcpInput({ $id: "urn:task-weaver:shared", type: "object", required: ["first"] }, { first: true });
  assert.throws(() => requireMcpInput({ $id: "urn:task-weaver:shared", type: "object", required: ["second"] }, { first: true }), McpInputValidationError);
});
