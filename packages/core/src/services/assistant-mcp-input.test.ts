import assert from "node:assert/strict";
import test from "node:test";
import { assistantOperationTools, executeAssistantOperation } from "./assistant-operations";

const toolId = "11111111-1111-4111-8111-111111111111";
const actor = { id: "22222222-2222-4222-8222-222222222222", type: "human" as const };

test("model MCP calls preserve dynamic fields through JSON input and retain existing approved object payloads", async () => {
  const received: unknown[] = [];
  const services = { mcpRegistryService: {
    getToolDetail: async () => ({ serverId: toolId }),
    getServer: async () => ({ config: {} }),
    callTool: async (_db: unknown, _id: string, input: unknown) => { received.push(input); return { content: [] }; },
  } } as any;
  await executeAssistantOperation({} as any, services, "call_mcp_tool", { toolId, argumentsJson: '{"key":"proof","nested":{"flag":true}}' }, actor);
  await executeAssistantOperation({} as any, services, "call_mcp_tool", { toolId, arguments: { old: "approved" } }, actor);
  assert.deepEqual(received, [{ key: "proof", nested: { flag: true } }, { old: "approved" }]);
  for (const argumentsJson of ["invalid", "null", "[]", '"string"']) await assert.rejects(() => executeAssistantOperation({} as any, services, "call_mcp_tool", { toolId, argumentsJson }, actor));
  assert.equal(received.length, 2);
  const definition = assistantOperationTools.find(tool => tool.function.name === "call_mcp_tool")!.function.parameters as { required: string[] };
  assert.ok(definition.required.includes("argumentsJson"));
});
