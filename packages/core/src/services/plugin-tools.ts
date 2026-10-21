import { eq } from "drizzle-orm";
import { mcpTools, type Database } from "@task-weaver/db";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError, pluginJsonValueSchema, type PluginManifest, type VerifiedRequestContext } from "@task-weaver/contracts";
import { capabilityDigest } from "./capability-digest";
import { resourceAuthority, type ResourceScope } from "./resource-authorization";
import { requireMcpServer, requireMcpToolTarget } from "./mcp-authorization";
import { mcpPolicy, mcpScopeKey, requireMcpApproval } from "./mcp-security";
import { mcpToolApprovalOperation } from "./mcp-local";
import { createResourceServices } from "./resource-services";
import type { McpPool } from "./mcp-registry";

export type PluginToolSnapshot = { name: string; toolId: string; schemaHash: string; result: unknown; untrusted: true };
const sameOrGlobal = (dependency: ResourceScope, installation: ResourceScope) => dependency.projectId
  ? dependency.projectId === installation.projectId
  : dependency.personalOwnerId ? dependency.personalOwnerId === installation.personalOwnerId && dependency.personalOwnerType === installation.personalOwnerType : true;

/** Resolve metadata only. No connection, approval consumption or remote call occurs here. */
export async function inspectPluginTools(db: Database, identity: VerifiedRequestContext, manifest: PluginManifest, scope: ResourceScope, method?: string, input?: unknown) {
  const authority = await resourceAuthority(db, identity);
  const result = [];
  for (const binding of manifest.toolBindings ?? []) {
    if (method !== undefined && binding.method !== method) continue;
    const tool = await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, binding.toolId) });
    if (!tool) throw new NotFoundError("Resource not found");
    const server = await requireMcpServer(db, authority, identity, tool.serverId, "mcp.invoke");
    if (!server.active || server.status !== "connected" || server.expiresAt && server.expiresAt <= new Date()) throw new NotFoundError("Resource not found");
    // Read-only classification is operator-controlled; uploaded code cannot assert it.
    if (!tool.readOnly || server.transport === "stdio" || !sameOrGlobal(server, scope)) throw new AuthorizationError();
    const schemaHash = capabilityDigest({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly, targetProjectArgument: tool.targetProjectArgument });
    if (schemaHash !== binding.schemaHash) throw new ConflictError("Pinned plugin tool schema changed", 0);
    const entries = Object.entries(binding.arguments);
    if (method !== undefined) for (const key of binding.inputArguments ?? []) {
      if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, key)) throw new ValidationError("Plugin input is missing a declared tool argument");
      entries.push([key, (input as Record<string, unknown>)[key]]);
    }
    if (tool.targetProjectArgument) {
      if (!scope.projectId || binding.inputArguments?.includes(tool.targetProjectArgument)) throw new AuthorizationError();
      const fixed = binding.arguments[tool.targetProjectArgument];
      if (fixed !== undefined && fixed !== scope.projectId) throw new AuthorizationError();
      entries.push([tool.targetProjectArgument, scope.projectId]);
    }
    const args = Object.fromEntries(entries);
    pluginJsonValueSchema.parse(args);
    const target = await requireMcpToolTarget(db, authority, server, tool, args);
    if (!sameOrGlobal(target, scope)) throw new AuthorizationError();
    const policy = await mcpPolicy(db, mcpScopeKey(target), tool.id);
    if (policy.mode === "deny") throw new AuthorizationError();
    const operation = mcpToolApprovalOperation(args, tool, server);
    result.push({ binding, args, target, operation, fingerprint: capabilityDigest({ operation, policy }) });
  }
  return result;
}
export type PluginToolPlan = Awaited<ReturnType<typeof inspectPluginTools>>;
const approvalFor = (approvals: Record<string, string> | undefined, name: string) => approvals && Object.hasOwn(approvals, name) ? approvals[name] : undefined;

export async function checkPluginToolApprovals(db: Database, identity: VerifiedRequestContext, plan: PluginToolPlan, approvals: Record<string, string> | undefined, consumed: boolean, completed?: ReadonlySet<string>) {
  if (approvals && Object.keys(approvals).some(name => !plan.some(item => item.binding.name === name))) throw new ValidationError("Plugin tool approval does not match a selected binding");
  for (const item of plan) {
    if (completed && !completed.has(item.binding.name)) continue;
    await requireMcpApproval(db, identity, item.target, item.binding.toolId, item.operation, approvalFor(approvals, item.binding.name), false, consumed);
  }
}

/** Only declared reads are dispatched by the credential-holding host, never by a worker. */
export async function runPluginTools(db: Database, identity: VerifiedRequestContext, plan: PluginToolPlan, approvals: Record<string, string> | undefined, pool: McpPool | undefined, signal: AbortSignal, completed: Set<string>, revalidate: () => Promise<unknown>) {
  if (!plan.length) return [];
  if (!pool) throw new ValidationError("The plugin MCP runtime is unavailable");
  // Obtain every required review before dispatching even the first read.
  await checkPluginToolApprovals(db, identity, plan, approvals, false);
  const snapshots: PluginToolSnapshot[] = [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  for (const item of plan) {
    deadline.throwIfAborted();
    await revalidate();
    const result = await createResourceServices(identity).mcpRegistryService.callTool(db, item.binding.toolId, item.args, identity.actor, pool, approvalFor(approvals, item.binding.name), item.binding.schemaHash, deadline);
    completed.add(item.binding.name);
    await revalidate();
    if (result.isError) throw new ValidationError("A declared plugin MCP read failed");
    pluginJsonValueSchema.parse(result);
    snapshots.push({ name: item.binding.name, toolId: item.binding.toolId, schemaHash: item.binding.schemaHash, result, untrusted: true });
    if (Buffer.byteLength(JSON.stringify(snapshots)) > 32768) throw new ValidationError("Plugin tool snapshots exceed the 32768-byte aggregate budget");
  }
  return snapshots;
}
