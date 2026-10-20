import type { Database } from "@task-weaver/db";
import { CAPABILITY_LIMITS, ValidationError, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { personalResourceOwnerId } from "../services/resource-authorization";
import { capabilityDigest } from "../services/capability-digest";
import type { McpPool } from "../services/mcp-registry";
import { McpToolFailure } from "./index";
import { DeferredMcpOperation } from "./security";

export const registrySchemaHash = (tool: { name: string; inputSchema: unknown; readOnly: boolean; targetProjectArgument: string | null }) => capabilityDigest({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument });

export async function registryOperation(db: Database, liveDb: Database, identity: VerifiedRequestContext, operation: "search" | "tool" | "call", raw: Record<string, unknown>, pool: McpPool | undefined, signal: AbortSignal) {
  const service = createResourceServices(identity).mcpRegistryService;
  if (operation === "search") {
    const rows = await service.searchTools(db, {
      intent: raw.intent as string, projectId: raw.projectId as string | undefined,
      includeGlobal: raw.includeGlobal as boolean, includePersonal: raw.includePersonal as boolean,
      ...(raw.includePersonal ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const } : {}),
      limit: raw.limit as number,
    });
    const items: unknown[] = [];
    for (const row of rows) {
      const item = { reference: { kind: "mcp_tool", id: row.id }, name: row.name.slice(0, 200), description: row.description?.slice(0, 512) ?? null, serverId: row.serverId, serverName: row.serverName.slice(0, 200), readOnly: row.readOnly, schemaHash: registrySchemaHash(row) };
      if (Buffer.byteLength(JSON.stringify({ items: [...items, item] })) > CAPABILITY_LIMITS.summaryBytes - 512) break;
      items.push(item);
    }
    return { items, meta: { limit: raw.limit, truncated: items.length !== rows.length, schemaLoading: "on_demand" } };
  }
  const tool = await service.getToolDetail(db, raw.toolId as string);
  const schemaHash = registrySchemaHash(tool);
  if (operation === "tool") {
    const result = { reference: { kind: "mcp_tool", id: tool.id }, name: tool.name, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument, schemaHash, server: tool.server };
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new McpToolFailure("result_too_large", "Tool schema exceeds the 32768-byte limit.");
    return result;
  }
  if (!pool) throw new ValidationError("The external MCP connection pool is unavailable");
  if (schemaHash !== raw.schemaHash) throw new McpToolFailure("version_conflict", "Tool schema changed; read and confirm the current schema before invoking.");
  if (Buffer.byteLength(JSON.stringify(raw.arguments)) > 16384) throw new ValidationError("External tool arguments exceed the 16384-byte limit");
  return new DeferredMcpOperation(async () => {
    signal.throwIfAborted();
    const result = await service.callTool(liveDb, tool.id, raw.arguments as Record<string, unknown>, identity.actor, pool, raw.targetApprovalId as string | undefined, schemaHash);
    signal.throwIfAborted();
    return { toolId: tool.id, schemaHash, untrustedOutput: true, result };
  }, async () => {});
}
