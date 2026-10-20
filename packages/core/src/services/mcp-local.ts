import { acquireMcpInvocation } from "./mcp-invocation-budget";
import { resolveHostedMcpRuntime } from "./mcp-hosted-runtime";
import { requireMcpApproval, recordMcpInvocationAudit, mcpPolicy, mcpScopeKey } from "./mcp-security";
import { personalResourceOwnerId, type ResourceScope } from "./resource-authorization";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, inArray } from "drizzle-orm";
import { type Database, mcpLocalRequests, mcpTools, mcpToolCalls } from "@task-weaver/db";
import { NotFoundError, AuthorizationError, ConflictError, callMcpToolSchema, completeLocalMcpRequestSchema, type Actor, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { resourceAuthority } from "./resource-authorization";
import { credentialBinding, requireMcpToolTarget, requireLocalHost, requireMcpServer } from "./mcp-authorization";
import { callTool, type McpPool } from "./mcp-registry";
import { capabilityDigest } from "./capability-digest";
import { ValidationError } from "@task-weaver/contracts";
import { redactAssistantValues } from "./assistant-assets";

async function requireQueuedTool(db: Database, item: typeof mcpLocalRequests.$inferSelect) {
  const tool = item.toolId ? await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, item.toolId) }) : undefined;
  if (!tool || tool.serverId !== item.serverId || tool.name !== item.toolName) throw new NotFoundError("Resource not found");
  const context = item.callerContext as unknown as VerifiedRequestContext;
  const authority = await resourceAuthority(db, context);
  const server = await requireMcpServer(db, authority, context, item.serverId, "mcp.invoke");
  const scope = await requireMcpToolTarget(db, authority, server, tool, item.arguments ?? {});
  const policy = await mcpPolicy(db, mcpScopeKey(scope), tool.id);
  if (policy.mode === "approval") {
    const approvalId = item.callerContext._mcpApprovalId;
    if (typeof approvalId !== "string") throw new AuthorizationError();
    await requireMcpApproval(db, context, scope, tool.id, approvalOperation(item.arguments ?? {}, tool, server), approvalId, false, true);
  }
  if (item.callerContext._mcpTool !== toolBinding(tool) || item.callerContext._mcpServer !== digest(serverBinding(server)) || policy.mode === "deny" || JSON.stringify(item.callerContext._mcpPolicy) !== JSON.stringify(policy)) throw new AuthorizationError();
}

const toolBinding = (tool: { id: string; name: string; inputSchema: unknown; readOnly: boolean; targetProjectArgument: string | null }) => JSON.stringify({ id: tool.id, name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument });
const serverBinding = (server: { id: string; projectId: string | null; personalOwnerId: string | null; transport: string; config: unknown; readOnly: boolean }) => JSON.stringify({ id: server.id, projectId: server.projectId, personalOwnerId: server.personalOwnerId, transport: server.transport, config: server.config, readOnly: server.readOnly, runtime: server.transport === "hosted-stdio" ? resolveHostedMcpRuntime(server).fingerprint : undefined });
const approvalOperation = (args: Record<string, unknown>, tool: unknown, server: Parameters<typeof serverBinding>[0]) => ({ args, tool, server: JSON.parse(serverBinding(server)) });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failed = () => ({ isError: true, content: [{ type: "text", text: "Local MCP invocation failed or expired" }] });

/** Network waits happen outside lifecycle transactions so the client can consume its mailbox. */
async function invokeMcpToolUnchecked(db: Database, context: VerifiedRequestContext, toolId: string, args: Record<string, unknown> | undefined, actor: Actor, pool: McpPool, approvalId?: string, expectedSchemaHash?: string, signal?: AbortSignal) {
  args = callMcpToolSchema.parse({ arguments: args }).arguments;
  const prepared = await db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const database = tx as unknown as Database;
    const authority = await resourceAuthority(database, context);
    if (actor.id !== authority.actor.id || actor.type !== authority.actor.type) throw new AuthorizationError();
    const tool = await tx.query.mcpTools.findFirst({ where: eq(mcpTools.id, toolId) });
    if (!tool) throw new NotFoundError("Resource not found");
    if (expectedSchemaHash && expectedSchemaHash !== capabilityDigest({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument })) throw new ValidationError("The tool schema changed; discover and confirm the current schema");
    const server = await requireMcpServer(database, authority, context, tool.serverId, "mcp.invoke");
    await requireMcpToolTarget(database, authority, server, tool, args);
    if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
    if (server.transport !== "stdio") {
      const partition = actor.id + ":" + credentialBinding(context);
      return { remote: { server, tool, partition } };
    }
    requireLocalHost(server, context);
    await tx.update(mcpLocalRequests).set({ status: "cancelled", arguments: null, result: null, callerContext: {}, leaseHash: null })
      .where(and(eq(mcpLocalRequests.serverId, server.id), lt(mcpLocalRequests.expiresAt, new Date())));
    const pending = await tx.query.mcpLocalRequests.findMany({ where: and(eq(mcpLocalRequests.serverId, server.id), inArray(mcpLocalRequests.status, ["queued", "running"])) });
    if (pending.filter(item => item.expiresAt > new Date()).length >= 32) throw new ConflictError("Local MCP queue is full", 0);
    const [request] = await tx.insert(mcpLocalRequests).values({
      serverId: server.id, toolId: tool.id, toolName: tool.name,
      callerContext: { ...context, _mcpApprovalId: approvalId ?? null, _mcpTool: toolBinding(tool), _mcpServer: digest(serverBinding(server)), _mcpPolicy: await mcpPolicy(database, mcpScopeKey(await requireMcpToolTarget(database, authority, server, tool, args)), tool.id) } as unknown as Record<string, unknown>,
      calledBy: actor.id, calledByType: actor.type, arguments: args,
      expiresAt: new Date(Date.now() + 30_000),
    }).returning();
    return { request: request! };
  });
  if ("remote" in prepared) {
    const remote = prepared.remote!;
    const revalidate = async () => db.transaction(async tx => {
      await lockIdentityLifecycle(tx);
      const database = tx as unknown as Database;
      const authority = await resourceAuthority(database, context);
      const server = await requireMcpServer(database, authority, context, remote.server.id, "mcp.invoke");
      const tool = await tx.query.mcpTools.findFirst({ where: eq(mcpTools.id, toolId) });
      if (tool) await requireMcpToolTarget(database, authority, server, tool, args);
      if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date() || !tool
        || tool.serverId !== remote.server.id || toolBinding(tool) !== toolBinding(remote.tool) || serverBinding(server) !== serverBinding(remote.server)
        || server.transport !== remote.server.transport || JSON.stringify(server.config) !== JSON.stringify(remote.server.config)) throw new AuthorizationError();
    });
    // External connections/calls must not hold lifecycle locks needed by cancellation or progress reads.
    const result = await callTool(db, toolId, args, actor, {
      getOrConnect: async record => {
        await revalidate();
        if (record.id !== remote.server.id) throw new AuthorizationError();
        const client = await pool.getOrConnect({ ...remote.server, authorizationPartition: remote.partition });
        return { listTools: () => client.listTools(), callTool: async input => { await revalidate(); return client.callTool(input, undefined, { signal, timeout: 25000 }); } };
      },
      disconnect: id => pool.disconnect(id), isConnected: id => pool.isConnected(id),
    }, undefined, undefined, signal);
    await revalidate();
    const headers = (remote.server.config as { headers?: Record<string, string> }).headers ?? {};
    return redactAssistantValues(result, [...Object.values(headers), ...(remote.server.transport === "hosted-stdio" ? Object.values(resolveHostedMcpRuntime(remote.server).secrets) : [])]);
  }
  const request = prepared.request;
  try {
    while (Date.now() < request.expiresAt.getTime()) {
      signal?.throwIfAborted();
      const state = await db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const database = tx as unknown as Database;
        const authority = await resourceAuthority(database, context);
        const server = await requireMcpServer(database, authority, context, request.serverId, "mcp.invoke");
        if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
        const item = await tx.query.mcpLocalRequests.findFirst({ where: eq(mcpLocalRequests.id, request.id) });
        if (!item || item.status === "cancelled") return { result: failed() };
        if (item.status !== "completed") return null;
        await tx.update(mcpLocalRequests).set({ result: null, arguments: null, callerContext: {}, leaseHash: null }).where(eq(mcpLocalRequests.id, item.id));
        return { result: item.result ?? failed() };
      });
      if (state) { signal?.throwIfAborted(); return state.result; }
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
    if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new AuthorizationError();
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
  if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
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

export async function invokeMcpTool(db: Database, context: VerifiedRequestContext, toolId: string, args: Record<string, unknown> | undefined, actor: Actor, pool: McpPool, approvalId?: string, expectedSchemaHash?: string, signal?: AbortSignal) {
  const start = Date.now();
  let scope: ResourceScope = { personalOwnerId: personalResourceOwnerId(context), personalOwnerType: "human" };
  let serverId = "unknown";
  let release = () => {};
  try {
    signal?.throwIfAborted();
    const authority = await resourceAuthority(db, context);
    const tool = await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, toolId) });
    if (!tool) throw new NotFoundError("Resource not found");
    if (expectedSchemaHash && expectedSchemaHash !== capabilityDigest({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument })) throw new ValidationError("The tool schema changed; discover and confirm the current schema");
    const server = await requireMcpServer(db, authority, context, tool.serverId, "mcp.invoke");
    serverId = server.id;
    if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
    scope = await requireMcpToolTarget(db, authority, server, tool, args);
    release = acquireMcpInvocation(context.actor.id, serverId);
    const policy = await mcpPolicy(db, mcpScopeKey(scope), toolId);
    await requireMcpApproval(db, context, scope, toolId, approvalOperation(args ?? {}, tool, server), approvalId);
    const checkedPool: McpPool = {
      disconnect: id => pool.disconnect(id),
      isConnected: id => pool.isConnected(id),
      getOrConnect: async record => {
        const current = await mcpPolicy(db, mcpScopeKey(scope), toolId);
        if (current.mode === "deny" || JSON.stringify(current) !== JSON.stringify(policy)) throw new AuthorizationError();
        const client = await pool.getOrConnect(record);
        return { listTools: () => client.listTools(), callTool: async input => {
          const current = await mcpPolicy(db, mcpScopeKey(scope), toolId);
          if (JSON.stringify(current) !== JSON.stringify(policy)) throw new AuthorizationError();
          if (approvalId) await requireMcpApproval(db, context, scope, toolId, approvalOperation(args ?? {}, tool, server), approvalId, false, true);
          return client.callTool(input, undefined, { signal, timeout: 25000 });
        } };
      },
    };
    const result = await invokeMcpToolUnchecked(db, context, toolId, args, actor, checkedPool, approvalId, expectedSchemaHash, signal);
    if (JSON.stringify(await mcpPolicy(db, mcpScopeKey(scope), toolId)) !== JSON.stringify(policy)) throw new AuthorizationError();
    const audit = await recordMcpInvocationAudit(db, context, scope, serverId, toolId, start, undefined, Boolean((result as { isError?: boolean }).isError));
    return { ...result, _meta: { ...(result._meta as Record<string, unknown> | undefined), "task-weaver/auditId": audit.id } };
  } catch (error) {
    await recordMcpInvocationAudit(db, context, scope, serverId, toolId, start, error);
    throw error;
  } finally { release(); }
}
