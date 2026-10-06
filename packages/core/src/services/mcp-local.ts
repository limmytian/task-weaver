import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, inArray } from "drizzle-orm";
import { type Database, mcpLocalRequests, mcpTools, mcpToolCalls } from "@task-weaver/db";
import { NotFoundError, AuthorizationError, ConflictError, callMcpToolSchema, completeLocalMcpRequestSchema, type Actor, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { resourceAuthority } from "./resource-authorization";
import { credentialBinding, requireLocalHost, requireMcpServer } from "./mcp-authorization";
import { callTool, type McpPool } from "./mcp-registry";

async function requireQueuedTool(db: Database, item: typeof mcpLocalRequests.$inferSelect) {
  const tool = item.toolId ? await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, item.toolId) }) : undefined;
  if (!tool || tool.serverId !== item.serverId || tool.name !== item.toolName) throw new NotFoundError("Resource not found");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failed = () => ({ isError: true, content: [{ type: "text", text: "Local MCP invocation failed or expired" }] });

/** Network waits happen outside lifecycle transactions so the client can consume its mailbox. */
export async function invokeMcpTool(db: Database, context: VerifiedRequestContext, toolId: string, args: Record<string, unknown> | undefined, actor: Actor, pool: McpPool) {
  args = callMcpToolSchema.parse({ arguments: args }).arguments;
  const prepared = await db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database;
    const authority = await resourceAuthority(database, context);
    if (actor.id !== authority.actor.id || actor.type !== authority.actor.type) throw new AuthorizationError();
    const tool = await tx.query.mcpTools.findFirst({ where: eq(mcpTools.id, toolId) });
    if (!tool) throw new NotFoundError("Resource not found");
    const server = await requireMcpServer(database, authority, context, tool.serverId, "mcp.invoke");
    if (!server.active || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
    if (server.transport !== "stdio") {
      const partition = actor.id + ":" + credentialBinding(context);
      const result = await callTool(database, toolId, args, actor, {
        getOrConnect: record => pool.getOrConnect({ ...record, authorizationPartition: partition }),
        disconnect: id => pool.disconnect(id), isConnected: id => pool.isConnected(id),
      });
      return { result };
    }
    requireLocalHost(server, context);
    await tx.update(mcpLocalRequests).set({ status: "cancelled", arguments: null, result: null, callerContext: {}, leaseHash: null })
      .where(and(eq(mcpLocalRequests.serverId, server.id), lt(mcpLocalRequests.expiresAt, new Date())));
    const pending = await tx.query.mcpLocalRequests.findMany({ where: and(eq(mcpLocalRequests.serverId, server.id), inArray(mcpLocalRequests.status, ["queued", "running"])) });
    if (pending.filter(item => item.expiresAt > new Date()).length >= 32) throw new ConflictError("Local MCP queue is full", 0);
    const [request] = await tx.insert(mcpLocalRequests).values({
      serverId: server.id, toolId: tool.id, toolName: tool.name,
      callerContext: context as unknown as Record<string, unknown>,
      calledBy: actor.id, calledByType: actor.type, arguments: args,
      expiresAt: new Date(Date.now() + 30_000),
    }).returning();
    return { request: request! };
  });
  if ("result" in prepared) return prepared.result!;
  const request = prepared.request;
  try {
    while (Date.now() < request.expiresAt.getTime()) {
      const state = await db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const database = tx as unknown as Database;
        const authority = await resourceAuthority(database, context);
        const server = await requireMcpServer(database, authority, context, request.serverId, "mcp.invoke");
        if (!server.active || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
        const item = await tx.query.mcpLocalRequests.findFirst({ where: eq(mcpLocalRequests.id, request.id) });
        if (!item || item.status === "cancelled") return { result: failed() };
        if (item.status !== "completed") return null;
        await tx.update(mcpLocalRequests).set({ result: null, arguments: null, callerContext: {}, leaseHash: null }).where(eq(mcpLocalRequests.id, item.id));
        return { result: item.result ?? failed() };
      });
      if (state) return state.result;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return failed();
  } finally {
    // Cleanup only this invocation's private payload, even if its credential has been revoked.
    await db.update(mcpLocalRequests).set({ status: "cancelled", result: null, arguments: null, callerContext: {}, leaseHash: null }).where(and(eq(mcpLocalRequests.id, request.id), eq(mcpLocalRequests.calledBy, actor.id)));
  }
}

/** Called only inside the verified facade after the host registration binding was checked. */
export async function pollLocalToolRequests(db: Database, serverId: string) {
  await db.update(mcpLocalRequests).set({ status: "cancelled", arguments: null, result: null, callerContext: {}, leaseHash: null })
    .where(and(eq(mcpLocalRequests.serverId, serverId), lt(mcpLocalRequests.expiresAt, new Date())));
  const requests = await db.query.mcpLocalRequests.findMany({
    where: and(eq(mcpLocalRequests.serverId, serverId), eq(mcpLocalRequests.status, "queued")),
    limit: 1, orderBy: (row, { asc }) => [asc(row.createdAt)],
  });
  const item = requests[0];
  if (!item) return [];
  try {
    const context = item.callerContext as unknown as VerifiedRequestContext;
    const authority = await resourceAuthority(db, context);
    const server = await requireMcpServer(db, authority, context, serverId, "mcp.invoke");
    if (!server.active || server.expiresAt && server.expiresAt <= new Date()) throw new AuthorizationError();
    await requireQueuedTool(db, item);
  } catch {
    await db.update(mcpLocalRequests).set({ status: "cancelled", arguments: null, callerContext: {} }).where(eq(mcpLocalRequests.id, item.id));
    return [];
  }
  const leaseToken = randomBytes(32).toString("hex");
  await db.update(mcpLocalRequests).set({ status: "running", leaseHash: digest(leaseToken) }).where(eq(mcpLocalRequests.id, item.id));
  return [{ id: item.id, toolName: item.toolName, arguments: item.arguments ?? {}, leaseToken, expiresAt: item.expiresAt }];
}

export async function completeLocalToolRequest(db: Database, id: string, input: { leaseToken: string; result: Record<string, unknown> }) {
  input = completeLocalMcpRequestSchema.parse(input);
  const item = await db.query.mcpLocalRequests.findFirst({ where: eq(mcpLocalRequests.id, id) });
  if (!item || item.status !== "running" || item.leaseHash !== digest(input.leaseToken) || item.expiresAt <= new Date()) throw new ConflictError("Local MCP invocation is expired or superseded", 0);
  const context = item.callerContext as unknown as VerifiedRequestContext;
  const authority = await resourceAuthority(db, context);
  const server = await requireMcpServer(db, authority, context, item.serverId, "mcp.invoke");
  if (!server.active || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
  await requireQueuedTool(db, item);
  await db.update(mcpLocalRequests).set({ status: "completed", result: input.result, arguments: null, leaseHash: null }).where(eq(mcpLocalRequests.id, id));
  await db.insert(mcpToolCalls).values({
    serverId: item.serverId, toolId: item.toolId, toolName: item.toolName,
    calledBy: item.calledBy, calledByType: item.calledByType,
    status: input.result.isError ? "error" : "success",
    durationMs: Date.now() - item.createdAt.getTime(),
    errorMessage: input.result.isError ? "Local MCP tool reported an error" : null,
  });
  return { completed: true };
}
