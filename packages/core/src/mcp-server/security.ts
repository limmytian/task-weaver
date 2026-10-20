import { lockIdentityLifecycle } from "../services/auth-security";
import { eq } from "drizzle-orm";
import { type Database, projects, tasks, requirements, documents, executionSlices, skillPackages, memories } from "@task-weaver/db";
import { AuthorizationError, mcpServerReadTools, type VerifiedRequestContext, type McpServerToolName } from "@task-weaver/contracts";
import { resourceAuthority, requireResource, requireScope, personalResourceOwnerId, type ResourceKind, type ResourceScope } from "../services/resource-authorization";
import { requireMcpApproval, recordMcpInvocationAudit, mcpPolicy, mcpScopeKey } from "../services/mcp-security";
import type { McpExecutor } from "./index";

async function target(db: Database, identity: VerifiedRequestContext, name: McpServerToolName, raw: Record<string, unknown>) {
  const authority = await resourceAuthority(db, identity);
  const write = !(mcpServerReadTools as readonly string[]).includes(name);
  const permission = write ? "resource.write" : "resource.read";
  const projectId = raw.projectId ?? (raw.plan as { projectId?: string } | undefined)?.projectId;
  let scope: ResourceScope = {};
  let revision: unknown = null;
  if (typeof raw.packageId === "string") {
    scope = await requireResource(db, authority, "package", raw.packageId, permission);
    const [record] = await db.select().from(skillPackages).where(eq(skillPackages.id, raw.packageId));
    revision = record;
  } else if (typeof raw.id === "string") {
    const kind: ResourceKind = name.startsWith("tw_memories_") ? "memory" : name.startsWith("tw_projects_") ? "project" : name.startsWith("tw_requirements_") || name.startsWith("tw_requirement_") || name === "tw_document_requirement_links_add" || name === "tw_execution_slices_list" || name === "tw_execution_slices_create" ? "requirement" : name === "tw_execution_slices_update" ? "slice" : name.startsWith("tw_documents_") || name.startsWith("tw_document_task") || name === "tw_context_get" ? "document" : "task";
    scope = await requireResource(db, authority, kind, raw.id, permission);
    const table = kind === "memory" ? memories : kind === "project" ? projects : kind === "requirement" ? requirements : kind === "slice" ? executionSlices : kind === "document" ? documents : tasks;
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
        return execute(name, input, signal, database);
      });
      await recordMcpInvocationAudit(db, identity, scope, "task-weaver", name, start);
      return result;
    } catch (error) {
      await recordMcpInvocationAudit(db, identity, scope, "task-weaver", name, start, error);
      throw error;
    }
  };
}
