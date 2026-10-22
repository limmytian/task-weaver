import { eq } from "drizzle-orm";
import { mcpServers, type Database } from "@task-weaver/db";
import { AuthorizationError, ValidationError, uploadMcpToolsSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { resourceAuthority } from "./resource-authorization";
import { requireMcpServer, credentialBinding } from "./mcp-authorization";
import { resolveHostedMcpRuntime } from "./mcp-hosted-runtime";
import { syncTools, type McpPool } from "./mcp-registry";
import { capabilityDigest } from "./capability-digest";

/** Remote initialization and schema reads must not hold the identity lifecycle lock. */
export async function synchronizeAuthorizedMcpTools(db: Database, context: VerifiedRequestContext, id: string, pool: McpPool) {
  const snapshot = async (database: Database) => {
    const authority = await resourceAuthority(database, context);
    const server = await requireMcpServer(database, authority, context, id, "mcp.manage");
    if (!server.active) throw new AuthorizationError();
    if (server.transport === "stdio") throw new ValidationError("Local stdio schemas must be uploaded by their registered client");
    const fingerprint = capabilityDigest({ server, runtime: server.transport === "hosted-stdio" ? resolveHostedMcpRuntime(server).fingerprint : undefined });
    return { server, fingerprint };
  };
  const before = await db.transaction(async tx => { await lockIdentityLifecycle(tx); return snapshot(tx as unknown as Database); });
  let tools: ReturnType<typeof uploadMcpToolsSchema.parse>["tools"];
  try {
    const client = await pool.getOrConnect({ ...before.server, authorizationPartition: context.actor.id + ":" + credentialBinding(context) });
    const result = await client.listTools();
    if (Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error("Schema catalog exceeds its byte limit");
    tools = uploadMcpToolsSchema.parse({ tools: result.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }).tools;
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Schema catalog contains duplicate names");
  } catch {
    // Do not overwrite a concurrently edited registration with a stale failure.
    await db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      const current = await snapshot(tx as unknown as Database);
      if (current.fingerprint === before.fingerprint) await tx.update(mcpServers).set({ status: "error", statusMessage: "MCP initialization or schema synchronization failed", updatedAt: new Date() }).where(eq(mcpServers.id, id));
    });
    throw new ValidationError("MCP initialization or schema synchronization failed; inspect runtime readiness");
  }
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const current = await snapshot(tx as unknown as Database);
    if (current.fingerprint !== before.fingerprint) throw new AuthorizationError();
    return syncTools(tx as unknown as Database, id, {
      getOrConnect: async () => ({ listTools: async () => ({ tools }), callTool: async () => { throw new Error("Schema synchronization cannot invoke tools"); } }),
      disconnect: serverId => pool.disconnect(serverId), isConnected: serverId => pool.isConnected(serverId),
    });
  });
}
