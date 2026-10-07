import { createTiExecutionService, isTiExecutionOperation } from './ti-execution';
import { inArray, and, eq, isNull, sql } from "drizzle-orm";
import {
  type Database, projects, requirements, tiAgentRuns, tasks, documents, memories, executionSlices,
  mcpTools, mcpLocalRequests, requirementRepositories, skillPackages, embeddingProfiles, embeddingJobs, embeddingGenerations, taskDependencies, requirementDependencies, documentLinks, documentTaskLinks,
  documentRequirementLinks, projectMemberships, activityLog, executionDelegations,
} from "@task-weaver/db";
import {
  AuthenticationError, AuthorizationError, NotFoundError, ValidationError, type Actor,
  type VerifiedRequestContext, stableActorReferenceSchema,
} from "@task-weaver/contracts";
import * as projectImplementation from "./projects";
import * as requirementImplementation from "./requirements";
import * as taskImplementation from "./tasks";
import * as claimImplementation from "./claims";
import * as documentImplementation from "./documents";
import * as memoryImplementation from "./memory";
import * as recommendationImplementation from "./recommendations";
import * as contextImplementation from "./context";
import { invokeMcpTool, pollLocalToolRequests, completeLocalToolRequest } from "./mcp-local";
import { mcpServerPredicate, requireMcpServer, requireLocalHost, credentialBinding } from "./mcp-authorization";
import * as repositoryImplementation from "./repositories";
import { repositoryPredicate, requireRepository, requireCatalogManagement } from "./repository-authorization";
import * as mcpImplementation from "./mcp-registry";
import * as embeddingImplementation from "./embeddings/index";
import { testEmbeddingProfile, embeddingProvider } from "./embedding-configuration";
import * as packageImplementation from "./skill-packages";
import { packageResourcePredicate, requirePackage, profileResourcePredicate, requireProfile, requireProfileManagement, canManageProvider } from "./asset-authorization";
import { auditIdentity, lockIdentityLifecycle } from "./auth-security";
import {
  canAccessResource, labelledResourcePredicate, qualifiedScopeColumns, taskResourcePredicate, memoryResourcePredicate, resourceAuthority, requireResource, requireScope, resourcePredicate, projectPredicate,
  validateAssignee, type ResourceAuthority, type ResourceKind, type ResourceScope,
} from "./resource-authorization";

import * as sloImplementation from "./daemon-slo";
import * as observabilityImplementation from "./daemon-observability";
import * as metricsImplementation from "./daemon-metrics";
import * as progressImplementation from "./daemon-progress";
import * as daemonImplementation from "./daemons";
import * as scheduleImplementation from "./schedules";
import * as tiImplementation from "./ti-agent";
import * as activityImplementation from "./activity-log";
import * as usageImplementation from "./agent-usage";
import * as reviewImplementation from "./reviews";
import { authorizeMetadataOperation } from "./metadata-authorization";

type Group = "project" | "requirement" | "task" | "claim" | "document" | "memory" | "recommendation" | "context" | "package" | "embedding" | "mcp" | "repository" | "usage" | "review" | "ti" | "activity" | "schedule" | "observability" | "metrics" | "progress" | "daemon" | "slo";
type Input = Record<string, any>;
const sources = {
  slo: sloImplementation, observability: observabilityImplementation, metrics: metricsImplementation, progress: progressImplementation, daemon: daemonImplementation, schedule: scheduleImplementation, ti: tiImplementation, activity: activityImplementation, usage: usageImplementation, review: reviewImplementation,
  repository: repositoryImplementation, project: projectImplementation, requirement: requirementImplementation, task: taskImplementation,
  claim: claimImplementation, document: documentImplementation, memory: memoryImplementation,
  recommendation: recommendationImplementation, context: contextImplementation, package: packageImplementation, embedding: { ...embeddingImplementation, testEmbeddingProfile }, mcp: { ...mcpImplementation, pollLocalToolRequests, completeLocalToolRequest },
};
const readById: Record<string, ResourceKind> = {
  getProject: "project", getRequirement: "requirement", getTask: "task", getTaskDetail: "task",
  getDocument: "document", getDocumentDetail: "document", getMemory: "memory", getExecutionSlice: "slice",
  getTaskClaim: "task", getRequirementClaim: "requirement", listExecutionSlices: "requirement",
  listRequirementDependencies: "requirement", checkBlockingDependencies: "task", checkBlockingRequirementDependencies: "requirement",
  getBacklinks: "document", getDocumentVersion: "document",
  getProjectStats: "project", getProjectHealthDashboard: "project", getKnowledgeGraph: "project",
  getKanbanBoard: "project", getGanttChart: "project", getRequirementHeatmap: "project",
  getRequirementBurndown: "requirement", getRequirementTaskDependencyGraph: "requirement",
  getDocumentRecommendations: "document", getTaskRecommendations: "task",
};
const writeById: Record<string, ResourceKind> = {
  updateProject: "project", deleteProject: "project", togglePin: "project",
  updateRequirement: "requirement", deleteRequirement: "requirement", createExecutionSlice: "requirement",
  updateExecutionSlice: "slice", deleteExecutionSlice: "slice", updateTask: "task", updateTaskStatus: "task",
  deleteTask: "task", addTaskComment: "task", addTaskNote: "task", updateDocument: "document",
  deleteDocument: "document", revertDocument: "document", updateMemory: "memory", forgetMemory: "memory",
  claimTask: "task", releaseTask: "task", heartbeatClaim: "task",
  claimRequirement: "requirement", releaseRequirement: "requirement", heartbeatRequirementClaim: "requirement",
};
const pure = new Set(["normalizeMarkdown", "parseWikiLinks", "inferDocType", "calculateSlidingRenewal", "reconcileUsage", "normalizeOutcomeSummary", "evaluateReviewPolicy", "resolveReviewPolicy", "tiAgentRetryBackoffMs", "activityLogToCsv", "buildDaemonMetricsReport", "buildDaemonSloReport", "schedulerPriorityRank", "progressPhaseForTaskStatus", "assertIndependentDeliveryIdentity"]);

/** Legacy implementations are private to core; package namespaces fail closed without this factory. */
export function createResourceServices(context: VerifiedRequestContext) {
  return bindServices(context);
}

function bindServices(context?: VerifiedRequestContext) {
  function bind<T extends object>(group: Group, source: T): T {
    return Object.fromEntries(Object.entries(source).map(([name, implementation]) => {
      if (typeof implementation !== "function" || pure.has(name)) return [name, implementation];
      return [name, async (...args: any[]) => {
        if (!context) throw new AuthorizationError();
        const db = args[0] as Database;
        if (group === "ti" && isTiExecutionOperation(name)) return createTiExecutionService(context).invoke(db, name, args.slice(1));
        if (group === "mcp" && name === "callTool") return invokeMcpTool(db, context, args[1], args[2], args[3], args[4]);
        return db.transaction(async tx => {
          // Serialize policy mutations with resource operations, including reads and nested relations.
          await lockIdentityLifecycle(tx);
          const txDb = tx as unknown as Database;
          const authority = await resourceAuthority(tx, context);
          const actor: Actor = { id: authority.actor.id, type: authority.actor.type };
          for (const arg of args.slice(1)) {
            if (arg && typeof arg === "object" && "id" in arg && "type" in arg && ["human", "agent"].includes(arg.type)) {
              if (arg.id !== actor.id || arg.type !== actor.type) throw new AuthorizationError();
            }
          }
          const call = [...args];
          call[0] = txDb;
          await authorizeOperation(txDb, authority, group, name, call, context);
          const removedDocumentLink = name === "unlinkDocumentFromTask"
            ? await tx.query.documentTaskLinks.findFirst({ where: eq(documentTaskLinks.id, call[1]) })
            : name === "unlinkDocumentFromRequirement"
              ? await tx.query.documentRequirementLinks.findFirst({ where: eq(documentRequirementLinks.id, call[1]) }) : undefined;
          if (group === "schedule" && name === "runScheduleNow") {
            const services = createResourceServices(context);
            call[3] = { createTask: services.taskService.createTask, createRun: services.tiAgentService.createRun };
          }
          let result: any;
          if (name === "createProject") {
            if (authority.actor.type !== "human" || !authority.grants.some(g => g.scope === "instance" && g.permissions.includes("project.create"))) throw new AuthorizationError();
            const [project] = await tx.insert(projects).values({ ...call[1], createdBy: actor.id }).returning();
            await tx.insert(projectMemberships).values({ projectId: project!.id, actorId: actor.id, actorType: "human", role: "owner" });
            await auditIdentity(tx, "project.created", actor.id, actor.id, project!.id);
            await tx.insert(activityLog).values({ entityType: "project", entityId: project!.id, action: "created", actorId: actor.id, actorType: actor.type });
            result = project;
          } else if (name === "deleteProject") {
            // Archive instead of cascading project data into unowned/global resources.
            result = await projectImplementation.updateProject(txDb, call[1], { status: "archived" }, actor);
          } else if (name === "batchUpdateTasks") {
            result = [];
            for (const update of call[1].updates) {
              const { id, status, reason, ...fields } = update;
              if (Object.keys(fields).length) await taskImplementation.updateTask(txDb, id, fields, actor);
              result.push(status === undefined ? await taskImplementation.getTask(txDb, id) : await taskImplementation.updateTaskStatus(txDb, id, status, actor, reason));
            }
          } else {
            result = await implementation(...call);
          }
          if (["recordMemory", "updateMemory", "forgetMemory", "unlinkDocuments", "unlinkDocumentFromTask", "unlinkDocumentFromRequirement", "removeTaskDependency", "togglePin"].includes(name)) {
            const entityId = typeof call[1] === "string" ? call[1] : result?.id;
            if (group === "memory") await auditIdentity(tx, `memory.${name}`, actor.id, actor.id, entityId);
            else await tx.insert(activityLog).values({ entityType: group === "claim" ? "task" : group as "project" | "requirement" | "task" | "document", entityId, action: name, actorId: actor.id, actorType: actor.type });
          }
          if (group === "task" && ["updateTask", "updateTaskStatus"].includes(name) && ["done", "cancelled"].includes(result?.status)) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), sql`${call[1]}::uuid = ANY(${executionDelegations.taskIds})`, result.status === "done" ? inArray(executionDelegations.purpose, ["execute", "automation"]) : undefined));
          }
          if (group === "requirement" && ["updateRequirement", "updateRequirementStatus"].includes(name) && ["done", "cancelled", "archived"].includes(result?.status)) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), eq(executionDelegations.requirementId, call[1])));
          }
          if (group === "task" && name === "updateTask" && ["requirementId", "executionSliceId", "assignee", "assigneeType"].some(key => key in (call[2] ?? {}))) {
            await tx.update(tiAgentRuns).set({ status: "cancelled", completedAt: new Date(), leaseExpiresAt: new Date() }).where(and(eq(tiAgentRuns.taskId, call[1]), inArray(tiAgentRuns.status, ["queued", "running", "in_review"])));
          }
          if (name === "updateTask" && ["requirementId", "executionSliceId", "assignee", "assigneeType"].some(key => key in (call[2] ?? {}))) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), sql`${call[1]}::uuid = ANY(${executionDelegations.taskIds})`));
          }
          if (name === "updateDocument" && ["projectId", "personalOwnerId", "personalOwnerType", "scope"].some(key => key in (call[2] ?? {}))) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), sql`${call[1]}::uuid = ANY(${executionDelegations.documentIds})`));
          }
          if (["addRequirementRepository", "removeRequirementRepository", "addTaskRepository", "removeTaskRepository"].includes(name)) {
            const target = name.includes("Task") ? sql`${call[1]}::uuid = ANY(${executionDelegations.taskIds})` : eq(executionDelegations.requirementId, call[1]);
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), target));
          }
          if (removedDocumentLink) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), sql`${removedDocumentLink.documentId}::uuid = ANY(${executionDelegations.documentIds})`));
          }
          if (["updateRepository", "archiveRepository"].includes(name)) {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), sql`${call[1]}::uuid = ANY(${executionDelegations.repositoryIds})`));
          }
          if (["updateProject", "deleteProject"].includes(name) && result?.status === "archived") {
            await tx.update(executionDelegations).set({ revokedAt: new Date() }).where(and(isNull(executionDelegations.revokedAt), eq(executionDelegations.projectId, call[1])));
          }
          if (group === "mcp" && name !== "callTool") result = redactMcpResult(authority, result);
          if (group === "embedding") result = redactEmbeddingResult(authority, result);
          if (group === "repository") result = redactRepositoryResult(result);
          if (group === "ti" || group === "activity" || group === "schedule") result = redactMetadataResult(result, group);
          if (authority.bounds) await auditIdentity(tx, "delegation.operation", actor.id, actor.id, authority.bounds.id, { operation: name, runId: authority.bounds.runId, requirementId: authority.bounds.requirementId, parentCredentialId: authority.bounds.parentCredentialId });
          const visible = await pruneRelations(txDb, authority, result);
          if (authority.bounds && authority.bounds.expiresAt <= new Date()) throw new AuthenticationError("credential_expired");
          return visible;
        });
      }];
    })) as T;
  }
  return {
    daemonSloService: bind("slo", sources.slo), daemonObservabilityService: bind("observability", sources.observability), daemonMetricsService: bind("metrics", sources.metrics), daemonProgressService: bind("progress", sources.progress), daemonService: bind("daemon", sources.daemon), scheduleService: bind("schedule", sources.schedule), tiAgentService: bind("ti", sources.ti), activityLogService: bind("activity", sources.activity), agentUsageService: bind("usage", sources.usage), reviewService: bind("review", sources.review), repositoryService: bind("repository", sources.repository), projectService: bind("project", sources.project), requirementService: bind("requirement", sources.requirement),
    taskService: bind("task", sources.task), claimService: bind("claim", sources.claim),
    documentService: bind("document", sources.document), memoryService: bind("memory", sources.memory),
    recommendationService: bind("recommendation", sources.recommendation), contextService: bind("context", sources.context), skillPackageService: bind("package", sources.package), embeddingService: bind("embedding", sources.embedding), mcpRegistryService: bind("mcp", sources.mcp),
  };
}

/** Compatibility names compile for staged adapters but cannot authorize a caller. */
export const { projectService, requirementService, taskService, claimService, documentService, memoryService, recommendationService, contextService, skillPackageService, embeddingService, mcpRegistryService, repositoryService, agentUsageService, reviewService, tiAgentService, activityLogService, scheduleService, daemonObservabilityService, daemonMetricsService, daemonProgressService, daemonService, daemonSloService } = bindServices();

async function checkTaskInput(db: Database, authority: ResourceAuthority, input: Input, current?: ResourceScope) {
  const scope: ResourceScope = current ?? (input.scope === "personal" ? {
    personalOwnerId: input.personalOwnerId ?? (authority.actor.type === "human" ? authority.actor.id : authority.actor.managedByActorId),
    personalOwnerType: input.personalOwnerType ?? "human",
  } : { projectId: input.projectId });
  requireScope(authority, scope);
  if (!current && input.scope === "personal") Object.assign(input, scope);
  if (input.requirementId) {
    const requirement = await requireResource(db, authority, "requirement", input.requirementId);
    if (!scope.projectId || requirement.projectId !== scope.projectId) throw new ValidationError("Task requirement must belong to the same project");
  }
  const targetSliceId = input.executionSliceId === undefined ? (current as Input | undefined)?.executionSliceId : input.executionSliceId;
  const targetRequirementId = input.requirementId ?? (current as Input | undefined)?.requirementId;
  if (targetSliceId) {
    const slice = await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, targetSliceId) });
    if (!slice) throw new NotFoundError("Resource not found");
    await requireResource(db, authority, "slice", slice.id);
    if (slice.requirementId !== targetRequirementId) throw new ValidationError("Slice must belong to the task requirement");
  }
  if (Object.hasOwn(input, "assignee") || Object.hasOwn(input, "assigneeType")) {
    const row = input.id ? await db.query.tasks.findFirst({ where: eq(tasks.id, input.id) }) : undefined;
    await validateAssignee(db, authority, scope, input.assignee === undefined ? row?.assignee : input.assignee, input.assigneeType === undefined ? row?.assigneeType : input.assigneeType);
  }
}

async function checkMemoryEntity(db: Database, authority: ResourceAuthority, input: Input) {
  if (!input.entityId && !input.entityType) return;
  if (!input.entityId || !["project", "requirement", "task", "document"].includes(input.entityType)) throw new ValidationError("Memory entity requires a supported resource and ID");
  await requireResource(db, authority, input.entityType, input.entityId);
}

function redactDelegatedInput(value: any): any {
  if (typeof value === "string") return value.replace(/\b(?:tw|twd|twb)_[0-9a-f]{64}\b/gi, "[redacted]");
  if (Array.isArray(value)) return value.map(redactDelegatedInput);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDelegatedInput(item)]));
  return value;
}

/** Task capabilities do not inherit the parent's project administration or unrelated write surfaces. */
function authorizeDelegatedOperation(authority: ResourceAuthority, group: Group, name: string, call: any[]) {
  const reads = new Set(["getProject", "getRequirement", "getTask", "getTaskDetail", "listTasks", "listRequirements", "listProjects", "getDocument", "getDocumentDetail", "listDocuments", "getTaskClaim", "getRequirementClaim", "listExecutionSlices", "listTaskComments", "listTaskNotes", "listDocumentVersions", "getDocumentVersion", "getRequirementRepositories", "getTaskRepositories", "listRequirementRepositories", "listTaskRepositories", "getRepository", "listRepositories", "bootstrapContext", "searchTasks", "searchRequirements", "searchDocuments", "searchDocumentsFulltext", "searchAll", "resolveTitles", "listContextEntries", "searchContext", "getContextEntry"]);
  const writes = new Set(["updateTask", "updateTaskStatus", "addTaskComment", "addTaskNote", "claimTask", "releaseTask", "heartbeatClaim", "updateDocument"]);
  if (!reads.has(name) && !(["execute", "automation"].includes(authority.bounds?.purpose ?? "") && writes.has(name))) throw new AuthorizationError();
  if (["usage", "review", "ti", "activity", "schedule", "observability", "metrics", "progress", "daemon", "mcp", "embedding", "memory", "package", "slo"].includes(group)) throw new AuthorizationError();
  if (name === "updateTask" && Object.keys(call[2] ?? {}).some(key => !["title", "description", "priority", "expectedAt", "expectedVersion", "version", "status", "reason", "daemonId", "leaseGeneration"].includes(key))) throw new AuthorizationError();
  if (name === "updateTaskStatus") {
    if (call[5] === true) throw new AuthorizationError();
    const fence = { daemonId: authority.bounds!.daemonId ?? undefined, leaseGeneration: Number(authority.bounds!.leaseGeneration) };
    if ((call[6]?.daemonId && call[6].daemonId !== fence.daemonId) || (call[6]?.leaseGeneration !== undefined && call[6].leaseGeneration !== fence.leaseGeneration)) throw new AuthorizationError();
    call[6] = fence;
  }
  if (name === "updateDocument" && Object.keys(call[2] ?? {}).some(key => !["title", "content", "version"].includes(key))) throw new AuthorizationError();
}

async function authorizeOperation(db: Database, authority: ResourceAuthority, group: Group, name: string, call: any[], context: VerifiedRequestContext) {
  if (authority.bounds) {
    authorizeDelegatedOperation(authority, group, name, call);
    for (let index = 1; index < call.length; index++) call[index] = redactDelegatedInput(call[index]);
  }
  if (group === "usage" || group === "review" || group === "ti" || group === "activity" || group === "schedule" || group === "observability" || group === "metrics" || group === "progress" || group === "daemon") return authorizeMetadataOperation(db, authority, group, name, call);
  const id = call[1];
  if (group === "repository") {
    const visibility = repositoryPredicate(authority);
    const predicates = { requirements: resourcePredicate(authority, requirements), tasks: taskResourcePredicate(authority) };
    if (name === "listRepositories") { call[3] = visibility; call[4] = predicates.requirements; return; }
    if (name === "getRepository" || name === "getRepositoryReadiness") {
      await requireRepository(db, authority, id); call[4] = visibility;
      if (name === "getRepository") call[5] = predicates;
      return;
    }
    if (name === "listRequirementRepositories" || name === "listTaskRepositories") {
      await requireResource(db, authority, name === "listTaskRepositories" ? "task" : "requirement", id);
      call[3] = visibility; return;
    }
    if (name === "createRepository") {
      await requireCatalogManagement(db, authority, id); return;
    }
    if (name === "updateRepository" || name === "archiveRepository") {
      const current = await requireRepository(db, authority, id);
      await requireCatalogManagement(db, authority, current);
      if (name === "updateRepository") {
        const next = { ...current, ...call[2] };
        await requireCatalogManagement(db, authority, next);
        if (current.visibility !== next.visibility || current.ownerId !== next.ownerId || current.ownerType !== next.ownerType)
          await auditIdentity(db, "repository.scope_changed", authority.actor.id, authority.actor.id, id, { fromVisibility: current.visibility, toVisibility: next.visibility, fromOwnerId: current.ownerId ?? "", toOwnerId: next.ownerId ?? "" });
        call[4] = visibility;
      } else call[3] = visibility;
      return;
    }
    if (["addRequirementRepository", "removeRequirementRepository", "addTaskRepository", "removeTaskRepository"].includes(name)) {
      const kind = name.includes("Task") ? "task" : "requirement";
      const scope = await requireResource(db, authority, kind, id, "repository.manage");
      const repositoryId = typeof call[2] === "string" ? call[2] : call[2].repositoryId;
      await requireRepository(db, authority, repositoryId);
      if (name === "addTaskRepository") {
        const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
        if (task!.scope !== "project" || !task!.requirementId) throw new ValidationError("Only project tasks can link repositories");
        const requirement = await requireResource(db, authority, "requirement", task!.requirementId, "repository.manage");
        if (requirement.projectId !== scope.projectId) throw new ValidationError("Task repository links must remain in their project");
      }
      if (name.startsWith("add")) call[4] = visibility;
      return;
    }
    // Execution delivery requires its later task-bound delegation implementation.
    throw new AuthorizationError();
  }
  if (group === "mcp") {
    if (name === "registerServer") { requireScope(authority, id, "mcp.manage"); call[3] = credentialBinding(context); return; }
    if (name === "listServers" || name === "searchTools") {
      if (id?.projectId) await requireResource(db, authority, "project", id.projectId);
      if (id?.includePersonal && (id.personalOwnerId || id.personalOwnerType)) requireScope(authority, id, "resource.read");
      const predicate = mcpServerPredicate(authority, context);
      call[2] = predicate; return;
    }
    let serverId = id;
    if (name === "completeLocalToolRequest") {
      const request = await db.query.mcpLocalRequests.findFirst({ where: eq(mcpLocalRequests.id, id) });
      if (!request) throw new NotFoundError("Resource not found");
      serverId = request.serverId;
    }
    if (["getToolDetail", "callTool"].includes(name)) {
      const tool = await db.query.mcpTools.findFirst({ where: eq(mcpTools.id, id) });
      if (!tool) throw new NotFoundError("Resource not found");
      serverId = tool.serverId;
    }
    const permission = ["updateServer", "deleteServer", "syncTools", "uploadTools", "heartbeatServer", "pollLocalToolRequests", "completeLocalToolRequest"].includes(name) ? "mcp.manage" : name === "callTool" ? "mcp.invoke" : "resource.read";
    if (!["getServer", "listServerTools", "getToolDetail", "callTool", "updateServer", "deleteServer", "syncTools", "uploadTools", "heartbeatServer", "pollLocalToolRequests", "completeLocalToolRequest"].includes(name)) throw new AuthorizationError();
    const server = await requireMcpServer(db, authority, context, serverId, permission);
    if (["heartbeatServer", "uploadTools", "pollLocalToolRequests", "completeLocalToolRequest"].includes(name)) requireLocalHost(server, context);
    if (["getToolDetail", "listServerTools", "callTool", "syncTools", "pollLocalToolRequests", "completeLocalToolRequest"].includes(name)
      && (!server!.active || server!.expiresAt && server!.expiresAt <= new Date())) throw new NotFoundError("Resource not found");
    if (name === "callTool" || name === "syncTools") {
      const poolIndex = name === "callTool" ? 4 : 2;
      const pool = call[poolIndex] as mcpImplementation.McpPool;
      const partition = authority.actor.id + ":" + context.credential.kind + ":" + context.credential.id;
      call[poolIndex] = {
        getOrConnect: (record: Parameters<mcpImplementation.McpPool["getOrConnect"]>[0]) => pool.getOrConnect({ ...record, authorizationPartition: partition }),
        disconnect: (serverId: string) => pool.disconnect(serverId),
        isConnected: (serverId: string) => pool.isConnected(serverId),
      };
    }
    if (name === "syncTools" && server.transport === "stdio") throw new ValidationError("Client-hosted MCP tools must be uploaded by their registered client");
    if (name === "updateServer") {
      if (call[2].transport && call[2].transport !== server.transport) throw new ValidationError("Transport changes require a new MCP registration");
      requireScope(authority, { ...server, ...call[2] }, "mcp.manage");
    }
    return;
  }
  if (group === "embedding") {
    if (name === "listEmbeddingProfiles") { call[1] = profileResourcePredicate(authority); return; }
    if (name === "createEmbeddingProfile") {
      requireProfileManagement(authority, id, true); return;
    }
    const reads = ["getEmbeddingProfile", "previewEmbeddingRebuild", "getEmbeddingUsage", "listEmbeddingGenerations", "getEmbeddingJob", "listEmbeddingJobItems"];
    const writes = ["updateEmbeddingProfile", "testEmbeddingProfile", "enableEmbeddingProfile", "setEmbeddingProfileStatus", "startEmbeddingRebuild", "cleanupRetiredEmbeddingGenerations", "markEmbeddingGenerationActive", "requestEmbeddingJobCancellation", "resumeEmbeddingJob", "retryFailedEmbeddingJobItems"];
    if (!reads.includes(name) && !writes.includes(name)) throw new AuthorizationError();
    let profileId = id;
    if (["getEmbeddingJob", "listEmbeddingJobItems", "requestEmbeddingJobCancellation", "resumeEmbeddingJob", "retryFailedEmbeddingJobItems"].includes(name)) {
      const job = await db.query.embeddingJobs.findFirst({ where: eq(embeddingJobs.id, id) });
      if (!job) throw new NotFoundError("Resource not found");
      profileId = job.profileId;
      if (["requestEmbeddingJobCancellation", "resumeEmbeddingJob", "retryFailedEmbeddingJobItems"].includes(name) && call[2] !== authority.actor.id) throw new AuthorizationError();
    }
    if (name === "markEmbeddingGenerationActive") {
      const generation = await db.query.embeddingGenerations.findFirst({ where: eq(embeddingGenerations.id, id) });
      if (!generation) throw new NotFoundError("Resource not found");
      profileId = generation.profileId;
    }
    const profile = await requireProfile(db, authority, profileId);
    if (writes.includes(name)) requireProfileManagement(authority, profile,
      ["updateEmbeddingProfile", "testEmbeddingProfile", "enableEmbeddingProfile", "markEmbeddingGenerationActive"].includes(name) || name === "setEmbeddingProfileStatus" && call[2] === "enabled");
    if (name === "enableEmbeddingProfile") { call[3] = embeddingProvider(profile); call[4] = resourcePredicate(authority, documents); }
    if (name === "setEmbeddingProfileStatus") call[4] = resourcePredicate(authority, documents);
    if (name === "startEmbeddingRebuild") call[4] = resourcePredicate(authority, documents);
    if (name === "listEmbeddingJobItems") call[2] = resourcePredicate(authority, documents);
    if (name === "previewEmbeddingRebuild") call[2] = resourcePredicate(authority, documents);
    return;
  }
  if (group === "package") {
    if (name === "registerPackage") {
      requireScope(authority, call[1]);
      const existing = await db.query.skillPackages.findMany({ where: eq(skillPackages.name, call[1].name) });
      for (const pkg of existing) {
        if ((pkg.projectId ?? null) === (call[1].projectId ?? null)
          && (pkg.personalOwnerId ?? null) === (call[1].personalOwnerId ?? null)
          && (pkg.personalOwnerType ?? null) === (call[1].personalOwnerType ?? null))
          await requirePackage(db, authority, pkg.id, "resource.write");
      }
      call[4] = resourcePredicate(authority, documents);
      return;
    }
    if (name === "listPackages") {
      if (id.projectId) await requireResource(db, authority, "project", id.projectId);
      if (id.includePersonal && (id.personalOwnerId || id.personalOwnerType)) requireScope(authority, id, "resource.read");
      call[2] = packageResourcePredicate(authority); return;
    }
    if (name === "getPackageMetadataForDocuments") {
      for (const documentId of id) await requireResource(db, authority, "document", documentId);
      call[2] = packageResourcePredicate(authority); return;
    }
    const reads = ["getPackage", "listPackageFiles", "readPackageTextFile", "downloadPackage", "verifyPackageStorage"];
    const writes = ["reindexPackageTextFiles", "updatePackageMetadata", "updatePackageVersionStatus"];
    if (!reads.includes(name) && !writes.includes(name)) throw new AuthorizationError();
    const packageId = typeof id === "string" ? id : id.packageId;
    await requirePackage(db, authority, packageId, writes.includes(name) ? "resource.write" : "resource.read");
    if (name === "reindexPackageTextFiles") call[4] = resourcePredicate(authority, documents);
    return;
  }
  if (name === "importSkill" || name === "bulkImportSkills") {
    for (const input of name === "bulkImportSkills" ? id : [id]) requireScope(authority, input);
    call[3] = resourcePredicate(authority, documents);
    return;
  }
  if (readById[name]) {
    const scope = await requireResource(db, authority, readById[name]!, id);
    const predicates = {
      tasks: taskResourcePredicate(authority), requirements: resourcePredicate(authority, requirements),
      documents: resourcePredicate(authority, documents),
    };
    if (["getProjectStats", "getProjectHealthDashboard", "getKnowledgeGraph", "getRequirementHeatmap"].includes(name)) call[2] = predicates;
    if (["getGanttChart", "getRequirementBurndown"].includes(name)) call[2] = predicates.tasks;
    if (name === "getRequirementTaskDependencyGraph") call[2] = and(predicates.tasks, eq(tasks.projectId, scope.projectId!));
    if (name === "getKanbanBoard") call[3] = predicates.tasks;
    if (name === "getDocumentRecommendations" || name === "getTaskRecommendations") {
      if (call[2]?.projectId) await requireResource(db, authority, "project", call[2].projectId);
      call[3] = predicates;
    }
    if (name === "getMemory") {
      const memory = await db.query.memories.findFirst({ where: eq(memories.id, id) });
      await checkMemoryEntity(db, authority, memory!);
    }
    return;
  }
  if (writeById[name]) {
    const scope = await requireResource(db, authority, writeById[name]!, id, group === "project" ? "project.manage" : name.includes("Requirement") && group === "claim" ? "execution.run" : "resource.write");
    if (name === "updateMemory" || name === "forgetMemory") {
      const memory = await db.query.memories.findFirst({ where: eq(memories.id, id) });
      await checkMemoryEntity(db, authority, memory!);
    }
    if (name === "updateTask") await checkTaskInput(db, authority, { ...call[2], id }, scope);
    if (name === "updateDocument" || name === "updateMemory") {
      const current = name === "updateDocument" ? await db.query.documents.findFirst({ where: eq(documents.id, id) }) : await db.query.memories.findFirst({ where: eq(memories.id, id) });
      const next = { ...current, ...call[2] };
      requireScope(authority, next);
      if (name === "updateMemory") await checkMemoryEntity(db, authority, next);
      if (current!.projectId !== next.projectId || ("personalOwnerId" in current! && current!.personalOwnerId !== next.personalOwnerId) || ("personalOwnerType" in current! && current!.personalOwnerType !== next.personalOwnerType)) {
        await auditIdentity(db, `${group}.scope_changed`, authority.actor.id, authority.actor.id, id, {
          fromProjectId: current!.projectId ?? "", toProjectId: next.projectId ?? "",
          fromOwnerId: current!.personalOwnerId ?? "", toOwnerId: next.personalOwnerId ?? "",
        });
      }
    }
    if (["createExecutionSlice", "updateExecutionSlice"].includes(name)) {
      const requirementId = name === "createExecutionSlice" ? id : (await db.query.executionSlices.findFirst({ where: eq(executionSlices.id, id) }))!.requirementId;
      for (const taskId of call[2].taskIds ?? []) {
        await requireResource(db, authority, "task", taskId, "resource.write");
        const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
        if (task!.requirementId !== requirementId) throw new ValidationError("Slice tasks must belong to its requirement");
      }
    }
    if (["createDocument", "updateDocument", "revertDocument"].includes(name)) call[4] = resourcePredicate(authority, documents);
    return;
  }
  if (["searchTasks", "searchRequirements", "searchDocuments", "searchDocumentsWithMetadata", "searchDocumentsFullText", "searchMemories", "searchContext", "listSkills"].includes(name)) {
    const input = call[1] ?? {};
    if (input.projectId) await requireResource(db, authority, "project", input.projectId);
    if ((input.includePersonal || input.scope === "personal") && (input.personalOwnerId || input.personalOwnerType)) requireScope(authority, { personalOwnerId: input.personalOwnerId, personalOwnerType: input.personalOwnerType }, "resource.read");
    if (input.entityId && input.entityType) await checkMemoryEntity(db, authority, input);
    call[2] = name === "searchTasks" ? taskResourcePredicate(authority)
      : name === "searchRequirements" ? resourcePredicate(authority, requirements)
      : name === "searchMemories" ? memoryResourcePredicate(authority) : resourcePredicate(authority, documents);
    if (name === "searchContext" || name === "listSkills") call[3] = packageResourcePredicate(authority);
    if (name === "searchDocuments" || name === "searchDocumentsWithMetadata") call[3] = labelledResourcePredicate(authority, embeddingProfiles);
    return;
  }
  if (name === "getDocumentByTitle" || name === "resolveDocumentTitles") { call[2] = resourcePredicate(authority, documents); return; }
  if (name === "getBootstrapContext") return;
  if (name === "createProject") return;
  if (name === "createTask" || name === "createPersonalTask") {
    call[1] = { ...call[1], ...(name === "createPersonalTask" ? { scope: "personal" } : {}) };
    await checkTaskInput(db, authority, call[1]); return;
  }
  if (name === "createRequirement") { requireScope(authority, call[1]); return; }
  if (name === "createDocument" || name === "recordMemory") {
    requireScope(authority, call[1]);
    if (name === "recordMemory") await checkMemoryEntity(db, authority, call[1]);
    else call[3] = resourcePredicate(authority, documents);
    return;
  }
  if (name === "batchCreateTasks" || name === "batchCreateRequirements" || name === "batchUpdateTasks" || name === "batchClaimTasks") {
    const inputs = name === "batchClaimTasks" ? call[1].map((taskId: string) => ({ id: taskId })) : call[1].tasks ?? call[1].requirements ?? call[1].updates;
    for (const input of inputs) {
      const scope = input.id ? await requireResource(db, authority, "task", input.id, "resource.write") : undefined;
      if (name === "batchCreateRequirements") requireScope(authority, input);
      else if (name !== "batchClaimTasks") await checkTaskInput(db, authority, input, scope);
    }
    return;
  }
  if (["listProjects", "listPinnedProjects", "getProjectCounts"].includes(name)) {
    const predicate = projectPredicate(authority);
    if (name === "listPinnedProjects") call[1] = predicate;
    else { if (name === "listProjects") call[1] ??= {}; call[2] = predicate; }
    if (name === "getProjectCounts") call[3] = taskResourcePredicate(authority, true);
    return;
  }
  if (["listTasks", "listRequirements", "listDocuments", "listMemories"].includes(name)) {
    const input = call[1];
    if (input.projectId) await requireResource(db, authority, "project", input.projectId);
    if (input.requirementId) await requireResource(db, authority, "requirement", input.requirementId);
    if ((input.includePersonal || input.scope === "personal") && (input.personalOwnerId || input.personalOwnerType)) requireScope(authority, { personalOwnerId: input.personalOwnerId, personalOwnerType: input.personalOwnerType }, "resource.read");
    const table = name === "listTasks" ? tasks : name === "listRequirements" ? requirements : name === "listDocuments" ? documents : memories;
    call[2] = name === "listMemories" ? memoryResourcePredicate(authority) : name === "listTasks" ? taskResourcePredicate(authority) : resourcePredicate(authority, table);
    return;
  }
  if (name === "listActiveClaims" || name === "listActiveRequirementClaims") {
    if (call[1]?.projectId) await requireResource(db, authority, "project", call[1].projectId);
    call[2] = name === "listActiveClaims" ? taskResourcePredicate(authority, true) : resourcePredicate(authority, qualifiedScopeColumns(requirements));
    return;
  }
  if (name === "listDocumentVersions" || name === "compareDocumentVersions") { await requireResource(db, authority, "document", call[1].documentId); return; }
  if (name === "addTaskDependency" || name === "addRequirementDependency") {
    const kind = name === "addTaskDependency" ? "task" : "requirement";
    const left = await requireResource(db, authority, kind, id, "resource.write");
    const right = await requireResource(db, authority, kind, call[2]);
    if (left.projectId !== right.projectId || left.personalOwnerId !== right.personalOwnerId || left.personalOwnerType !== right.personalOwnerType) throw new ValidationError("Dependencies must share their resource scope");
    return;
  }
  if (name === "linkDocuments" || name === "linkDocumentToTask" || name === "linkDocumentToRequirement") {
    const kind = name === "linkDocumentToRequirement" ? "requirement" : "document";
    await requireResource(db, authority, kind, id, "resource.write");
    await requireResource(db, authority, name === "linkDocuments" ? "document" : name === "linkDocumentToTask" ? "task" : "document", call[2]);
    return;
  }
  const linkTables = { unlinkDocuments: documentLinks, unlinkDocumentFromTask: documentTaskLinks, unlinkDocumentFromRequirement: documentRequirementLinks, removeTaskDependency: taskDependencies, removeRequirementDependency: requirementDependencies };
  if (name in linkTables) {
    if (!stableActorReferenceSchema.safeParse({ id, type: "human" }).success) throw new ValidationError("Invalid relationship ID");
    const table = linkTables[name as keyof typeof linkTables];
    const [link] = await db.select().from(table).where(eq(table.id, id));
    if (!link) throw new NotFoundError("Resource not found");
    const value = link as Input;
    const endpoints: Array<[ResourceKind, string]> = name === "unlinkDocuments" ? [["document", value.sourceDocId], ["document", value.targetDocId]]
      : name === "unlinkDocumentFromTask" ? [["document", value.documentId], ["task", value.taskId]]
      : name === "unlinkDocumentFromRequirement" ? [["requirement", value.requirementId], ["document", value.documentId]]
      : name === "removeTaskDependency" ? [["task", value.taskId], ["task", value.dependsOnTaskId]] : [["requirement", value.requirementId], ["requirement", value.dependsOnRequirementId]];
    const expectedParentId = name === "removeRequirementDependency" ? call[3] : call[2];
    if (expectedParentId && endpoints[0]![1] !== expectedParentId) throw new NotFoundError("Resource not found");
    for (const [index, [kind, resourceId]] of endpoints.entries()) await requireResource(db, authority, kind, resourceId, index === 0 ? "resource.write" : "resource.read");
    return;
  }
  if (name === "getMemoriesForEntity") {
    await checkMemoryEntity(db, authority, { entityType: id, entityId: call[2] });
    call[3] = memoryResourcePredicate(authority); return;
  }
  // B2/B3/B4/C own discovery, system metadata, runtime grants and streams.
  throw new AuthorizationError();
}

async function checkRepositoryLink(db: Database, authority: ResourceAuthority, link: any) {
  await requireRepository(db, authority, link.repositoryId);
  if (link.requirementId) await requireResource(db, authority, "requirement", link.requirementId);
  if (link.taskId) {
    await requireResource(db, authority, "task", link.taskId);
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, link.taskId) });
    if (task!.scope !== "project" || !task!.requirementId) throw new NotFoundError("Resource not found");
    const workspace = await db.query.requirementRepositories.findFirst({ where: and(eq(requirementRepositories.requirementId, task!.requirementId), eq(requirementRepositories.repositoryId, link.repositoryId)) });
    if (!workspace) throw new NotFoundError("Resource not found");
  }
}

async function pruneRelations(db: Database, authority: ResourceAuthority, result: any): Promise<any> {
  if (result instanceof Map) {
    const visible = new Map();
    for (const [key, value] of result) visible.set(key, await pruneRelations(db, authority, value));
    return visible;
  }
  if (Array.isArray(result)) {
    const visible = [];
    for (const row of result) {
      if (authority.bounds && row?.id && "orderIndex" in row && "allowParallel" in row && !authority.bounds.sliceIds.includes(row.id)) continue;
      if (row && typeof row === "object") {
        const endpoints: Array<[ResourceKind, string]> = [];
        if (row.id && (row.scope === "project" || row.scope === "personal") && "requirementId" in row) endpoints.push(["task", row.id]);
        if (row.sourceDocId) endpoints.push(["document", row.sourceDocId]);
        if (row.targetDocId) endpoints.push(["document", row.targetDocId]);
        if (row.documentId && (row.taskId || row.requirementId)) endpoints.push(["document", row.documentId]);
        if (row.taskId) endpoints.push(["task", row.taskId]);
        if (row.requirementId) endpoints.push(["requirement", row.requirementId]);
        if (row.dependsOnTaskId) endpoints.push(["task", row.dependsOnTaskId]);
        if (row.dependsOnRequirementId) endpoints.push(["requirement", row.dependsOnRequirementId]);
        let allowed = true;
        const repositoryLink = row.repositoryId ? row : row.link?.repositoryId ? row.link : undefined;
        if (repositoryLink) {
          try { await checkRepositoryLink(db, authority, repositoryLink); }
          catch (error) { if (error instanceof NotFoundError) allowed = false; else throw error; }
        }
        for (const [kind, id] of endpoints) {
          try { await requireResource(db, authority, kind, id); }
          catch (error) { if (error instanceof NotFoundError) allowed = false; else throw error; }
        }
        if (!allowed) continue;
      }
      visible.push(await pruneRelations(db, authority, row));
    }
    return visible;
  }
  if (!result || typeof result !== "object" || result instanceof Date) return result;
  const copy = { ...result };
  if (Array.isArray(copy.repositories)) copy.repositories = await pruneRelations(db, authority, copy.repositories);
  if (copy.repository) copy.repository = redactRepositoryResult(copy.repository);
  delete copy.storageObject;
  if (copy.status === "storage_error" && "message" in copy) copy.message = "Package storage object is unavailable";
  delete copy.objectKey;
  delete copy.storageKeyPrefix;
  const targets: Record<string, ResourceKind> = { targetDoc: "document", sourceDoc: "document", document: "document", task: "task", dependsOn: "task", requirement: "requirement" };
  for (const key of ["outgoingLinks", "incomingLinks", "taskLinks", "requirementLinks", "documentLinks", "dependencies", "dependents"]) {
    if (!Array.isArray(copy[key])) continue;
    const visible = [];
    for (const relation of copy[key]) {
      let permitted = true;
      for (const [target, kind] of Object.entries(targets)) {
        if (!relation[target]?.id) continue;
        try { await requireResource(db, authority, target === "dependsOn" && "projectId" in relation[target] && !("scope" in relation[target]) ? "requirement" : kind, relation[target].id); }
        catch (error) { if (error instanceof NotFoundError) permitted = false; else throw error; }
      }
      if (permitted) visible.push(await pruneRelations(db, authority, relation));
    }
    copy[key] = visible;
  }
  for (const [key, value] of Object.entries(copy)) {
    if (["repositories", "outgoingLinks", "incomingLinks", "taskLinks", "requirementLinks", "documentLinks", "dependencies", "dependents"].includes(key)) continue;
    if (value && typeof value === "object" && !(value instanceof Date)) copy[key] = await pruneRelations(db, authority, value);
  }
  return copy;
}

function redactEmbeddingResult(authority: ResourceAuthority, value: any): any {
  if (Array.isArray(value)) return value.map(item => redactEmbeddingResult(authority, item));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const result = { ...value };
  // Provider configuration is visible only to administrators with explicit resource management rights.
  if ("secretRef" in result && !canManageProvider(authority, result)) {
    result.secretRef = ""; result.baseUrl = "";
  }
  for (const key of ["lastErrorSummary", "errorSummary", "leaseOwner", "leaseToken", "requestReason"]) if (key in result) result[key] = null;
  if (!("secretRef" in result) && "baseUrl" in result) result.baseUrl = "";
  for (const [key, child] of Object.entries(result)) if (child && typeof child === "object" && !(child instanceof Date)) result[key] = redactEmbeddingResult(authority, child);
  return result;
}

function redactMcpResult(authority: ResourceAuthority, value: any): any {
  if (Array.isArray(value)) return value.map(item => redactMcpResult(authority, item));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const result = { ...value };
  if ("registeredBy" in result && "transport" in result) {
    const config = result.config;
    result.config = canAccessResource(authority, result, "mcp.manage")
      ? result.transport === "stdio" ? { command: config.command, args: config.args }
        : { url: config.url }
      : result.transport === "stdio" ? { command: "" } : { url: "" };
    result.statusMessage = null;
    delete result.registeredCredentialId;
    delete result.clientId; delete result.nodeId;
  }
  for (const [key, child] of Object.entries(result)) if (child && typeof child === "object" && !(child instanceof Date)) result[key] = redactMcpResult(authority, child);
  return result;
}


function redactRepositoryResult(result: any): any {
  if (Array.isArray(result)) return result.map(redactRepositoryResult);
  if (!result || typeof result !== "object" || result instanceof Date) return result;
  const copy = { ...result };
  if (copy.authPolicy) {
    copy.authPolicy = { ...copy.authPolicy };
    delete copy.authPolicy.credentialProfileRef;
    delete copy.authPolicy.hostKeyPolicyRef;
  }
  for (const [key, value] of Object.entries(copy))
    if (value && typeof value === "object" && !(value instanceof Date)) copy[key] = redactRepositoryResult(value);
  return copy;
}

function redactMetadataResult(value: any, group: string): any {
  if (Array.isArray(value)) return value.map(item => redactMetadataResult(item, group));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["authorization", "apiKeyRef", "baseUrl", "sandboxSessionId", "eventLog", "errorMessage", "leaseOwnerId", "leaseOwnerType", "leaseExpiresAt"].includes(key)).map(([key, item]) => [key, group === "activity" && key === "metadata" ? {} : redactMetadataResult(item, group)]));
}
