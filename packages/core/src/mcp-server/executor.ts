import { inArray } from "drizzle-orm";
import { mcpInvocationPolicies } from "@task-weaver/db";
import { mcpScopeKey } from "../services/mcp-security";
import { secureMcpExecutor } from "./security";
import { submitMcpPlan } from "./planning";
import { readMcpContext } from "./context";
import { mcpSlices } from "./slices";
import { readCapabilityBootstrap } from "./bootstrap";
import { prepareSkillExecution } from "./skill-execution";
import { listSkillRuntimes } from "../services/skill-runtime";
import { mcpMemory } from "./memory";
import { resolveMcpSkill } from "./skill-resolution";
import { readMcpPackage, readMcpSkill, listMcpPackages } from "./discovery";
import type { SkillPackageStorageAdapter } from "../services/skill-package-storage";
import type { Database } from "@task-weaver/db";
import type { VerifiedRequestContext } from "@task-weaver/contracts";
import { AuthorizationError, isMcpServerToolAllowed, mcpServerCatalog, mcpServerReadTools, createTaskSchema, listTasksSchema, createRequirementSchema, updateRequirementSchema, updateTaskSchema, createDocumentSchema, updateDocumentSchema, listProjectsSchema, listRequirementsSchema, listDocumentsSchema } from "@task-weaver/contracts";
import { createResourceServices } from "../services/resource-services";
import { personalResourceOwnerId, resourceAuthority, canAccessResource } from "../services/resource-authorization";
import type { McpExecutor } from "./index";

function paged(value: unknown) {
  const result = value as { items: unknown[]; total: number; page: number; pageSize: number };
  return { items: result.items, meta: { page: result.page, pageSize: result.pageSize, total: result.total, nextPage: result.page * result.pageSize < result.total ? result.page + 1 : null } };
}

/** Only the API constructs this executor, using server-verified request context. */
export function createAuthorizedMcpExecutor(db: Database, identity: VerifiedRequestContext, storage?: SkillPackageStorageAdapter, runtimeProfiles?: string, readOnly = false): McpExecutor {
  const liveDb = db;
  const services = createResourceServices(identity);
  const { projectService: projects, requirementService: requirements, taskService: tasks, documentService: documents, claimService: claims } = services;
  const actor = { id: identity.actor.id, type: identity.actor.type };
  const owner = { personalOwnerId: personalResourceOwnerId(identity), personalOwnerType: "human" as const };
  return secureMcpExecutor(db, identity, async (name, raw, signal, db) => {
    signal.throwIfAborted();
    const visibleTools = (await authorizedMcpToolNames(db, identity)).filter(tool => isMcpServerToolAllowed(tool, readOnly));
    if (!visibleTools.includes(name)) throw new AuthorizationError();
    // Inputs have already passed the strict shared MCP schema. Re-parse business
    // payloads below to preserve refinements and defaults in the canonical contracts.
    const id = raw.id as string;
    const page = { page: raw.page as number, pageSize: raw.pageSize as number };
    switch (name) {
      case "tw_skill_runtimes_list": return listSkillRuntimes(runtimeProfiles);
      case "tw_skills_run": return prepareSkillExecution(db, liveDb, identity, raw, storage, runtimeProfiles, signal);
      case "tw_memories_search": return mcpMemory(db, identity, "search", raw);
      case "tw_skill_packages_resolve": return resolveMcpSkill(db, identity, raw as { packageId: string; version?: string }, signal);
      case "tw_memories_preview": return mcpMemory(db, identity, "preview", raw);
      case "tw_memories_get": return mcpMemory(db, identity, "get", raw);
      case "tw_memories_record": return mcpMemory(db, identity, "record", raw);
      case "tw_memories_update": return mcpMemory(db, identity, "update", raw);
      case "tw_memories_forget": return mcpMemory(db, identity, "forget", raw);
      case "tw_plan_validate": return submitMcpPlan(db, identity, { plan: raw.plan }, signal);
      case "tw_plan_apply": return submitMcpPlan(db, identity, { plan: raw.plan, idempotencyKey: raw.idempotencyKey as string }, signal);
      case "tw_tasks_context": return readMcpContext(db, identity, "task", raw as unknown as Parameters<typeof readMcpContext>[3], signal);
      case "tw_requirements_context": return readMcpContext(db, identity, "requirement", raw as unknown as Parameters<typeof readMcpContext>[3], signal);
      case "tw_execution_slices_list": return mcpSlices(db, identity, "list", raw);
      case "tw_execution_slices_create": return mcpSlices(db, identity, "create", raw);
      case "tw_execution_slices_update": return mcpSlices(db, identity, "update", raw);
      case "tw_context_bootstrap": {
        await services.contextService.getBootstrapContext(db);
        return readCapabilityBootstrap(visibleTools, runtimeProfiles);
      }
      case "tw_context_search": {
        const items = await services.contextService.searchContext(db, { intent: raw.intent as string, limit: raw.limit as number, mode: "summary", projectId: raw.projectId as string | undefined, includeGlobal: raw.includeGlobal as boolean, includePersonal: raw.includePersonal as boolean, ...(raw.includePersonal ? owner : {}) });
        return { items: items.map(({ skillPackage: _package, ...item }) => item), meta: { limit: raw.limit, paginationSupported: false } };
      }
      case "tw_context_get": return readMcpSkill(db, identity, id, raw.expectedVersion as number | undefined);
      case "tw_skill_packages_list": return listMcpPackages(db, identity, raw as unknown as Parameters<typeof listMcpPackages>[2]);
      case "tw_skill_packages_get": return readMcpPackage(db, identity, "get", raw as { packageId: string }, storage);
      case "tw_skill_package_files": return readMcpPackage(db, identity, "files", raw as { packageId: string }, storage);
      case "tw_skill_package_read": return readMcpPackage(db, identity, "read", raw as { packageId: string }, storage);
      case "tw_projects_discover": return projects.discoverProjects(db, listProjectsSchema.parse(raw));
      case "tw_projects_list": return paged(await projects.listProjects(db, { ...listProjectsSchema.parse(raw), view: "summary" }));
      case "tw_projects_get": return projects.getProject(db, id);
      case "tw_requirements_list": return paged(await requirements.listRequirements(db, { ...listRequirementsSchema.parse(raw), view: "summary" }));
      case "tw_requirements_get": return requirements.getRequirementRecord(db, id);
      case "tw_requirements_create": return requirements.createRequirement(db, createRequirementSchema.parse(raw), actor);
      case "tw_requirements_update": return requirements.updateRequirement(db, id, updateRequirementSchema.parse(raw.patch), actor);
      case "tw_requirement_dependencies_list": return requirements.listRequirementDependenciesPage(db, id, page);
      case "tw_requirement_dependencies_add": return requirements.addRequirementDependency(db, id, raw.dependsOnRequirementId as string, raw.type as "blocks" | "related", actor, raw.description as string | undefined);
      case "tw_requirement_dependencies_remove": return requirements.removeRequirementDependency(db, raw.dependencyId as string, actor, id);
      case "tw_tasks_list": return paged(await tasks.listTasks(db, { ...listTasksSchema.parse({ ...raw, ...(raw.scope === "personal" ? owner : {}) }), view: "summary" }));
      case "tw_tasks_get": return tasks.getTask(db, id);
      case "tw_tasks_create": return tasks.createTask(db, createTaskSchema.parse({ ...raw, ...(raw.scope === "personal" ? owner : {}) }), actor);
      case "tw_tasks_update": return tasks.updateTask(db, id, updateTaskSchema.parse(raw.patch), actor);
      case "tw_tasks_status": return tasks.updateTaskStatus(db, id, raw.status as "todo" | "in_progress" | "in_review" | "done" | "cancelled", actor, raw.reason as string | undefined);
      case "tw_tasks_claim": return claims.claimTask(db, id, actor, raw.durationMinutes as number);
      case "tw_tasks_heartbeat": return claims.heartbeatClaim(db, id, actor, raw.extendMinutes as number);
      case "tw_tasks_release": return claims.releaseTask(db, id, actor, raw.reason as string | undefined);
      case "tw_task_comments_list": return tasks.listTaskCommentsPage(db, id, page);
      case "tw_task_comments_add": return tasks.addTaskComment(db, id, raw.content as string, actor);
      case "tw_task_dependencies_list": return tasks.listTaskDependenciesPage(db, id, page);
      case "tw_task_dependencies_add": return tasks.addTaskDependency(db, id, raw.dependsOnTaskId as string, raw.type as "blocks" | "related", actor, raw.description as string | undefined);
      case "tw_task_dependencies_remove": return tasks.removeTaskDependency(db, raw.dependencyId as string, id);
      case "tw_documents_list": return paged(await documents.listDocuments(db, { ...listDocumentsSchema.parse(raw), ...(raw.includePersonal ? owner : {}), view: "summary" }));
      case "tw_documents_get": return documents.getDocument(db, id);
      case "tw_documents_create": return documents.createDocument(db, createDocumentSchema.parse({ ...raw, ...(raw.scope === "personal" ? owner : {}) }), actor);
      case "tw_documents_update": return documents.updateDocument(db, id, updateDocumentSchema.parse(raw.patch), actor);
      case "tw_document_task_links_add": return documents.linkDocumentToTask(db, id, raw.taskId as string, raw.linkType as "references" | "documents" | "output", actor);
      case "tw_document_requirement_links_add": return requirements.linkDocumentToRequirement(db, id, raw.documentId as string, raw.linkType as "references" | "documents" | "output", actor);
      case "tw_search": {
        const query = raw.query as string;
        const projectId = raw.projectId as string | undefined;
        const scope = raw.scope as "project" | "personal";
        const limit = raw.limit as number;
        const entity = raw.entity as string;
        const sourceLimit = limit + 1;
        const [taskRows, requirementRows, documentResult] = await Promise.all([
          entity === "all" || entity === "task" ? tasks.searchTasks(db, { query, projectId, scope, ...(scope === "personal" ? owner : {}), limit: sourceLimit }) : [],
          scope !== "personal" && (entity === "all" || entity === "requirement") ? requirements.searchRequirements(db, { query, projectId, limit: sourceLimit }) : [],
          entity === "all" || entity === "document" ? documents.searchDocumentsWithMetadata(db, { query, projectId, mode: raw.mode as "keyword" | "fulltext" | "semantic" | "hybrid", includeGlobal: raw.includeGlobal as boolean, includePersonal: scope === "personal", ...(scope === "personal" ? owner : {}), limit: sourceLimit, keywordWeight: 0.3, fulltextWeight: 0.7 }) : { items: [], metadata: null },
        ]);
        signal.throwIfAborted();
        const groups = [taskRows.map(row => ({ ...row, type: "task" })), requirementRows.map(row => ({ ...row, type: "requirement" })), documentResult.items.map(row => ({ ...(row as Record<string, unknown>), type: "document" }))];
        const items: unknown[] = [];
        // Interleave types so one entity cannot consume the whole merged budget.
        for (let i = 0; i < sourceLimit; i++) for (const group of groups) if (group[i]) items.push(group[i]);
        return { items: items.slice(0, limit), meta: { limit, hasMore: items.length > limit, paginationSupported: false, matchedTypes: groups.map((group, index) => group.length ? ["task", "requirement", "document"][index] : null).filter(Boolean), documentSearch: documentResult.metadata } };
      }
    }
  });
}

/** A catalog is a hint; facade operations still authorize the actual target IDs. */
export async function authorizedMcpToolNames(db: Database, identity: VerifiedRequestContext): Promise<readonly string[]> {
  const authority = await resourceAuthority(db, identity);
  if (authority.bounds) return [];
  const scopeKeys = authority.grants.flatMap(grant => grant.scope === "instance" ? [] : [mcpScopeKey(grant.scope === "project" ? { projectId: grant.projectId } : grant.scope === "personal" ? { personalOwnerId: grant.actorId } : {})]);
  const policies = scopeKeys.length ? await db.select().from(mcpInvocationPolicies).where(inArray(mcpInvocationPolicies.scopeKey, scopeKeys)) : [];
  const names: string[] = [];
  for (const tool of mcpServerCatalog) {
    const projectOnly = /^tw_(projects|requirements|requirement_dependencies|execution_slices|plan)_/.test(tool.name);
    const permission = tool.name === "tw_projects_discover" ? "project.discover" : (mcpServerReadTools as readonly string[]).includes(tool.name) && tool.name !== "tw_plan_validate" ? "resource.read" : "resource.write";
    for (const grant of authority.grants) {
      if (grant.scope === "instance" || !grant.permissions.includes(permission)) continue;
      if (projectOnly && tool.name !== "tw_projects_discover" && grant.scope !== "project") continue;
      const scope = grant.scope === "project" ? { projectId: grant.projectId } : grant.scope === "personal" ? { personalOwnerId: grant.actorId } : {};
      if (["tw_skills_run", "tw_skill_runtimes_list"].includes(tool.name) && !canAccessResource(authority, scope, "mcp.invoke")) continue;
      if (!policies.some(policy => policy.scopeKey === mcpScopeKey(scope) && [tool.name, "*"].includes(policy.toolId) && policy.mode === "deny")) { names.push(tool.name); break; }
    }
  }
  return names;
}
