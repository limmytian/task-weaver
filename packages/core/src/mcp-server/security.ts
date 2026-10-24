import { requireRepository } from "../services/repository-authorization";
import { requireMcpServer, requireMcpToolTarget } from "../services/mcp-authorization";
import { lockIdentityLifecycle } from "../services/auth-security";
import { eq } from "drizzle-orm";
import { type Database, projects, tasks, requirements, documents, executionSlices, skillPackages, memories, mcpTools } from "@task-weaver/db";
import { AuthorizationError, mcpServerReadTools, type VerifiedRequestContext, type McpServerToolName } from "@task-weaver/contracts";
import { resourceAuthority, requireResource, requireScope, personalResourceOwnerId, type ResourceKind, type ResourceScope } from "../services/resource-authorization";
import { requireMcpApproval, recordMcpInvocationAudit, mcpPolicy, mcpScopeKey } from "../services/mcp-security";
import type { McpExecutor } from "./index";

/** Trusted preparation completes under the policy lock; isolated work runs after commit. */
export class DeferredMcpOperation {
  constructor(readonly run: () => Promise<unknown>, readonly dispose: () => Promise<void>) {}
}

async function target(db: Database, identity: VerifiedRequestContext, name: McpServerToolName, raw: Record<string, unknown>) {
  const authority = await resourceAuthority(db, identity);
  const write = !(mcpServerReadTools as readonly string[]).includes(name);
  const permission = write ? "resource.write" : "resource.read";
  const projectId = raw.projectId ?? (raw.plan as { projectId?: string } | undefined)?.projectId;
  let scope: ResourceScope = {};
  let revision: unknown = null;
  if (name === "tw_repository_readiness") {
    const repository = await requireRepository(db, authority, raw.id as string);
    scope = repository.visibility === "instance" ? {} : { personalOwnerId: repository.ownerId, personalOwnerType: "human" };
  } else if (name === "tw_dependencies_graph") {
    scope = await requireResource(db, authority, raw.kind as "task" | "requirement", raw.id as string, "resource.read");
  } else if (name === "tw_mcp_readiness") {
    scope = await requireMcpServer(db, authority, identity, raw.serverId as string, "resource.read");
  } else if (name === "tw_mcp_tool" || name === "tw_mcp_call") {
    const tool = await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, raw.toolId as string) });
    if (!tool) throw new AuthorizationError();
    const server = await requireMcpServer(db, authority, identity, tool.serverId, "mcp.invoke");
    scope = name === "tw_mcp_call" ? await requireMcpToolTarget(db, authority, server, tool, raw.arguments as Record<string, unknown>) : server;
    revision = { tool, server };
  } else if (name === "tw_skills_run") {
    scope = raw.scope === "personal" ? { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" }
      : raw.scope === "global" ? {} : { projectId: raw.projectId as string };
    requireScope(authority, scope, "resource.write");
    requireScope(authority, scope, "mcp.invoke");
    await requireResource(db, authority, "package", raw.packageId as string, "resource.read");
    const [record] = await db.select().from(skillPackages).where(eq(skillPackages.id, raw.packageId as string));
    revision = record;
  } else if (typeof raw.packageId === "string") {
    scope = await requireResource(db, authority, "package", raw.packageId, permission);
    const [record] = await db.select().from(skillPackages).where(eq(skillPackages.id, raw.packageId));
    revision = record;
  } else if (typeof raw.id === "string") {
    const kind: ResourceKind = name.startsWith("tw_memories_") ? "memory" : name.startsWith("tw_projects_") ? "project" : name.startsWith("tw_requirements_") || name.startsWith("tw_requirement_") || name === "tw_document_requirement_links_add" || name === "tw_execution_slices_list" || name === "tw_execution_slices_create" ? "requirement" : name === "tw_execution_slices_update" ? "slice" : name === "tw_context_get" ? "skill" : name.startsWith("tw_documents_") || name.startsWith("tw_document_task") || name === "tw_document_history" || name === "tw_document_version" ? "document" : "task";
    scope = await requireResource(db, authority, kind, raw.id, permission);
    const table = kind === "memory" ? memories : kind === "project" ? projects : kind === "requirement" ? requirements : kind === "slice" ? executionSlices : (kind === "document" || kind === "skill") ? documents : tasks;
    const [record] = await db.select().from(table).where(eq(table.id, raw.id));
    revision = record;
  } else if (typeof projectId === "string") {
    scope = await requireResource(db, authority, "project", projectId, permission);
    const [record] = await db.select().from(projects).where(eq(projects.id, projectId));
    revision = record;
  } else if (raw.scope === "personal" || raw.includePersonal === true) {
    scope = { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" };
    requireScope(authority, scope, permission);
  } else if (write) requireScope(authority, scope, permission);
  return { scope, revision, write };
}

export function secureMcpExecutor(db: Database, identity: VerifiedRequestContext, execute: (name: McpServerToolName, input: Record<string, unknown>, signal: AbortSignal, database: Database) => Promise<unknown>): McpExecutor {
  return async (name, raw, signal) => {
    const start = Date.now();
    let scope: ResourceScope = { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" };
    let deferred: DeferredMcpOperation | undefined;
    const { approvalId, ...input } = raw;
    try {
      const resolved = await target(db, identity, name, input);
      scope = resolved.scope;
      const policy = await mcpPolicy(db, mcpScopeKey(scope), name);
      if (policy.mode === "deny") throw new AuthorizationError();
      if (resolved.write) await requireMcpApproval(db, identity, scope, name, { input, revision: resolved.revision }, approvalId as string | undefined, false);
      const result = await db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const database = tx as unknown as Database;
        const current = await target(database, identity, name, input);
        if (JSON.stringify(await mcpPolicy(database, mcpScopeKey(current.scope), name)) !== JSON.stringify(policy)) throw new AuthorizationError();
        if (current.write) await requireMcpApproval(database, identity, current.scope, name, { input, revision: current.revision }, approvalId as string | undefined);
        const value = await execute(name, input, signal, database);
        if (value instanceof DeferredMcpOperation) deferred = value;
        return value;
      });
      const completed = deferred ? await deferred.run() : result;
      if (deferred) {
        const current = await target(db, identity, name, input);
        if (mcpScopeKey(current.scope) !== mcpScopeKey(scope) || JSON.stringify(await mcpPolicy(db, mcpScopeKey(current.scope), name)) !== JSON.stringify(policy)) throw new AuthorizationError();
      }
      await recordMcpInvocationAudit(db, identity, scope, "task-weaver", name, start);
      return completed;
    } catch (error) {
      await recordMcpInvocationAudit(db, identity, scope, "task-weaver", name, start, error);
      throw error;
    } finally {
      await deferred?.dispose();
    }
  };
}
