import { assistantSkillStorage, cleanAssistantToolData, redactAssistantValues } from "./assistant-assets";
import { mcpPool } from "./mcp-pool";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as schemas from "@task-weaver/contracts";
import type { Actor } from "@task-weaver/contracts";
import type { Database } from "@task-weaver/db";
import { createResourceServices } from "./resource-services";
type Services = ReturnType<typeof createResourceServices>;
type Operation = {
    schema: z.ZodTypeAny;
    description: string;
    kind: "project" | "requirement" | "task" | "document" | "schedule" | "ti_agent_run" | "memory" | "package" | "mcp";
    target?: string;
    external?: boolean;
    run: (db: Database, services: Services, input: any, actor: Actor) => Promise<any>;
};
const uuid = z.string().uuid();
const id = (key: string) => z.object({ [key]: uuid }).strict();
const update = (key: string, schema: z.ZodTypeAny) => z.object({ [key]: uuid, changes: schema }).strict();
const operation = (schema: z.ZodTypeAny, description: string, kind: Operation["kind"], run: Operation["run"], target?: string): Operation => ({ schema, description, kind, run, target });
/** Same validated business services as REST/CLI; identity and actor are never model arguments. */
export const assistantOperations: Record<string, Operation> = {
    record_memory: operation(schemas.recordMemorySchema.omit({ personalOwnerId: true, personalOwnerType: true, metadata: true }).strict(), "Save a memory for this account or the supplied project. Memories are reference data, not permission to perform operations.", "memory", (db, s, p, a) => s.memoryService.recordMemory(db, p.projectId ? p : { ...p, personalOwnerId: a.id, personalOwnerType: a.type }, a)),
    update_memory: operation(update("memoryId", schemas.updateMemorySchema.omit({ personalOwnerId: true, personalOwnerType: true, metadata: true })), "Edit an accessible memory's content, title, tags or expiry.", "memory", (db, s, p, a) => s.memoryService.updateMemory(db, p.memoryId, p.changes, a), "memoryId"),
    forget_memory: operation(id("memoryId"), "Delete an accessible memory. This removes stored knowledge, not the current conversation.", "memory", async (db, s, p, a) => { await s.memoryService.forgetMemory(db, p.memoryId, a); return { deleted: true }; }, "memoryId"),
    save_skill: operation(z.object({ name: z.string().min(1).max(500), version: z.string().min(1).max(100), projectId: uuid.optional(), description: z.string().max(2000).optional(), entryPath: schemas.skillPackagePathSchema.default("SKILL.md"), tags: z.array(z.string()).max(30).optional(), files: z.array(z.object({ path: schemas.skillPackagePathSchema, content: z.string().min(1).max(32_000) }).strict()).min(1).max(20) }).strict(), "Create or replace a text skill version using complete files, including its entry file. Read the existing skill before editing it. Omitting projectId saves in your personal library. Loading a skill does not execute shell commands.", "package", async (db, s, p, a) => {
      const input = schemas.registerSkillPackageSchema.parse({ ...p, ...(p.projectId ? {} : { personalOwnerId: a.id, personalOwnerType: a.type }), sourceType: "directory", storageBackend: "local", files: p.files.map((f: any) => ({ path: f.path, contentBase64: Buffer.from(f.content).toString("base64"), contentType: "text/plain", kind: f.path === p.entryPath ? "entry" : "text", isReadableText: true })) });
      const saved = await s.skillPackageService.registerPackage(db, input, a, assistantSkillStorage());
      return { ...cleanAssistantToolData(saved), id: saved.id };
    }),
    update_skill: operation(schemas.updateSkillPackageMetadataSchema.strict(), "Update a skill's metadata or set status to archived/deleted. Content changes use save_skill after reading its files.", "package", (db, s, p, a) => s.skillPackageService.updatePackageMetadata(db, p, a), "packageId"),
    update_skill_version: operation(schemas.updateSkillPackageVersionStatusSchema.strict(), "Activate, deprecate, archive or delete a specific skill version.", "package", (db, s, p, a) => s.skillPackageService.updatePackageVersionStatus(db, p, a), "packageId"),
    register_mcp_server: operation(z.object({ name: z.string().min(1).max(255), description: z.string().max(1000).optional(), projectId: uuid.optional(), transport: z.enum(["sse", "streamable-http"]), url: z.string().url(), tags: z.array(z.string()).max(30).optional() }).strict(), "Register a remote MCP server for the account or supplied project. Configure authentication securely in the MCP UI; never put secrets in Chat. Local stdio hosting requires the external registered client.", "mcp", (db, s, p, a) => s.mcpRegistryService.registerServer(db, schemas.registerMcpServerSchema.parse({ ...p, ...(p.projectId ? {} : { personalOwnerId: a.id, personalOwnerType: a.type }), config: { url: p.url } }), a)),
    update_mcp_server: operation(update("serverId", z.object({ name: z.string().min(1).max(255).optional(), description: z.string().max(1000).nullable().optional(), active: z.boolean().optional(), tags: z.array(z.string()).max(30).optional() }).strict()), "Rename, describe, enable or disable an accessible MCP server without changing credentials or ownership.", "mcp", (db, s, p, a) => s.mcpRegistryService.updateServer(db, p.serverId, p.changes, a), "serverId"),
    delete_mcp_server: operation(id("serverId"), "Remove an accessible MCP server registration and its tools.", "mcp", async (db, s, p, a) => { await s.mcpRegistryService.deleteServer(db, p.serverId, a); await mcpPool.disconnect(p.serverId); return { deleted: true }; }, "serverId"),
    sync_mcp_tools: { ...operation(id("serverId"), "Refresh a remote MCP server's tool schemas. Local stdio tools must be uploaded by their registered client.", "mcp", (db, s, p) => s.mcpRegistryService.syncTools(db, p.serverId, mcpPool), "serverId"), external: true },
    call_mcp_tool: { ...operation(schemas.callMcpToolSchema.extend({ toolId: uuid }).strict(), "Invoke an accessible external MCP tool. Inspect get_mcp_tool first for its input schema. Calls can have external effects and always follow account confirmation/automatic operation mode. Never repeat a call whose outcome is unknown.", "mcp", async (db, s, p, a) => {
      const tool = await s.mcpRegistryService.getToolDetail(db, p.toolId);
      const server = await s.mcpRegistryService.getServer(db, tool.serverId);
      const headerValues = Object.values((server.config as { headers?: Record<string, string> }).headers ?? {});
      const result = await s.mcpRegistryService.callTool(db, p.toolId, p.arguments, a, mcpPool);
      if (result.isError) throw new schemas.ValidationError("External MCP call failed or its outcome is unknown; do not retry automatically");
      return { id: tool.serverId, toolId: p.toolId, output: cleanAssistantToolData(redactAssistantValues(result, headerValues)) };
    }), external: true },
    create_project: operation(schemas.createProjectSchema.strict(), "Create a project.", "project", (db, s, p, a) => s.projectService.createProject(db, p, a)),
    update_project: operation(update("projectId", schemas.updateProjectSchema), "Update project details or archive a project.", "project", (db, s, p, a) => s.projectService.updateProject(db, p.projectId, p.changes, a), "projectId"),
    archive_project: operation(id("projectId"), "Archive a project using normal CLI lifecycle rules.", "project", (db, s, p, a) => s.projectService.deleteProject(db, p.projectId, a), "projectId"),
    create_requirement: operation(schemas.createRequirementSchema.strict(), "Create a requirement under a project. Use the returned id to create tasks.", "requirement", (db, s, p, a) => s.requirementService.createRequirement(db, p, a)),
    update_requirement: operation(update("requirementId", schemas.updateRequirementSchema), "Update a requirement, including status, priority and model tier.", "requirement", (db, s, p, a) => s.requirementService.updateRequirement(db, p.requirementId, p.changes, a), "requirementId"),
    cancel_requirement: operation(id("requirementId"), "Cancel a requirement using normal CLI lifecycle rules.", "requirement", (db, s, p, a) => s.requirementService.deleteRequirement(db, p.requirementId, a), "requirementId"),
    create_task: operation(schemas.createTaskSchema, "Create a project task. projectId and requirementId are required. Use a real requirement id, never invent one. For an unassigned task omit both assignee and assigneeType; never send the string null.", "task", (db, s, p, a) => s.taskService.createTask(db, p, a)),
    create_personal_task: operation(schemas.createPersonalTaskSchema, "Create a task in the signed-in account's personal space.", "task", (db, s, p, a) => s.taskService.createPersonalTask(db, p, a)),
    claim_task: operation(schemas.claimTaskSchema.extend({ taskId: uuid }).strict(), "Claim a task as the signed-in actor, respecting dependency and active claim rules.", "task", (db, s, p, a) => s.claimService.claimTask(db, p.taskId, a, p.durationMinutes), "taskId"),
    release_task: operation(schemas.releaseTaskSchema.extend({ taskId: uuid }).strict(), "Release the signed-in actor's task claim.", "task", (db, s, p, a) => s.claimService.releaseTask(db, p.taskId, a, p.reason), "taskId"),
    update_task: operation(update("taskId", schemas.updateTaskSchema), "Update task details, assignee, priority or execution slice.", "task", (db, s, p, a) => s.taskService.updateTask(db, p.taskId, p.changes, a), "taskId"),
    change_task_status: operation(z.object({ taskId: uuid, status: schemas.taskStatusSchema, reason: z.string().optional() }).strict(), "Change task status while respecting dependency and active execution lease rules.", "task", (db, s, p, a) => s.taskService.updateTaskStatus(db, p.taskId, p.status, a, p.reason, false), "taskId"),
    cancel_task: operation(id("taskId"), "Cancel a task using normal CLI lifecycle rules.", "task", (db, s, p, a) => s.taskService.deleteTask(db, p.taskId, a), "taskId"),
    add_task_dependency: operation(schemas.createTaskDependencySchema.extend({ taskId: uuid }).strict(), "Make taskId depend on dependsOnTaskId. blocks enforces execution order; related is informational.", "task", (db, s, p, a) => s.taskService.addTaskDependency(db, p.taskId, p.dependsOnTaskId, p.type, a, p.description), "taskId"),
    add_requirement_dependency: operation(schemas.createRequirementDependencySchema.extend({ requirementId: uuid }).strict(), "Add ordering or related links between requirements.", "requirement", (db, s, p, a) => s.requirementService.addRequirementDependency(db, p.requirementId, p.dependsOnRequirementId, p.type, a, p.description), "requirementId"),
    remove_task_dependency: operation(z.object({ taskId: uuid, dependencyId: uuid }).strict(), "Remove a dependency belonging to taskId.", "task", (db, s, p) => s.taskService.removeTaskDependency(db, p.dependencyId, p.taskId), "taskId"),
    remove_requirement_dependency: operation(z.object({ requirementId: uuid, dependencyId: uuid }).strict(), "Remove a dependency belonging to requirementId.", "requirement", (db, s, p, a) => s.requirementService.removeRequirementDependency(db, p.dependencyId, a, p.requirementId), "requirementId"),
    link_document_requirement: operation(z.object({ requirementId: uuid, documentId: uuid, linkType: z.enum(["references", "documents", "output"]) }).strict(), "Link a document to a requirement.", "requirement", (db, s, p, a) => s.requirementService.linkDocumentToRequirement(db, p.requirementId, p.documentId, p.linkType, a), "requirementId"),
    unlink_document_requirement: operation(z.object({ requirementId: uuid, linkId: uuid }).strict(), "Remove a document link belonging to requirementId.", "requirement", (db, s, p) => s.requirementService.unlinkDocumentFromRequirement(db, p.linkId, p.requirementId), "requirementId"),
    create_execution_slice: operation(schemas.createExecutionSliceSchema.extend({ requirementId: uuid }).strict(), "Group tasks into an ordered requirement execution slice. Set taskIds, orderIndex and allowParallel for orchestration.", "requirement", (db, s, p, a) => s.requirementService.createExecutionSlice(db, p.requirementId, p, a), "requirementId"),
    update_execution_slice: operation(update("sliceId", schemas.updateExecutionSliceSchema), "Update execution slice order, parallelism, task membership or state.", "requirement", async (db, s, p, a) => { const slice = await s.requirementService.updateExecutionSlice(db, p.sliceId, p.changes, a); return { ...slice, id: slice.requirementId, sliceId: slice.id }; }),
    add_comment: operation(z.object({ taskId: uuid, content: z.string().min(1).max(8000) }).strict(), "Add a task comment.", "task", (db, s, p, a) => s.taskService.addTaskComment(db, p.taskId, p.content, a), "taskId"),
    add_note: operation(schemas.createTaskNoteSchema.extend({ taskId: uuid }).strict(), "Add a pinned or ordinary task note.", "task", (db, s, p, a) => s.taskService.addTaskNote(db, p.taskId, p.content, p.pinned, a), "taskId"),
    create_document: operation(schemas.createDocumentSchema, "Create a document in a project or the account's personal space.", "document", (db, s, p, a) => s.documentService.createDocument(db, p, a)),
    update_document: operation(update("documentId", schemas.updateDocumentSchema), "Update document content and metadata.", "document", (db, s, p, a) => s.documentService.updateDocument(db, p.documentId, p.changes, a), "documentId"),
    delete_document: operation(id("documentId"), "Delete a document using normal CLI lifecycle rules.", "document", async (db, s, p, a) => { await s.documentService.deleteDocument(db, p.documentId, a); return { deleted: true }; }, "documentId"),
    revert_document: operation(z.object({ documentId: uuid, version: z.number().int().min(1), changeDescription: z.string().optional() }).strict(), "Restore a document's earlier version.", "document", (db, s, p, a) => s.documentService.revertDocument(db, p.documentId, p, a), "documentId"),
    unlink_document_task: operation(z.object({ documentId: uuid, linkId: uuid }).strict(), "Remove a task link belonging to documentId.", "document", (db, s, p) => s.documentService.unlinkDocumentFromTask(db, p.linkId, p.documentId), "documentId"),
    link_document_task: operation(z.object({ documentId: uuid, taskId: uuid, linkType: z.enum(["references", "documents", "output"]) }).strict(), "Link a document with a task.", "document", (db, s, p, a) => s.documentService.linkDocumentToTask(db, p.documentId, p.taskId, p.linkType, a), "documentId"),
    create_schedule: operation(schemas.createScheduleSchema, "Create a recurring or one-off task schedule.", "schedule", (db, s, p, a) => s.scheduleService.createSchedule(db, p, a)),
    update_schedule: operation(update("scheduleId", schemas.updateScheduleSchema), "Update, pause or resume a task schedule.", "schedule", (db, s, p, a) => s.scheduleService.updateSchedule(db, p.scheduleId, p.changes, a), "scheduleId"),
    archive_schedule: operation(id("scheduleId"), "Archive a schedule.", "schedule", (db, s, p, a) => s.scheduleService.archiveSchedule(db, p.scheduleId, a), "scheduleId"),
    run_schedule: operation(id("scheduleId"), "Run a schedule now, subject to project execution policies.", "schedule", (db, s, p, a) => s.scheduleService.runScheduleNow(db, p.scheduleId, a), "scheduleId"),
    queue_ti_run: operation(schemas.createTiAgentRunSchema, "Queue a Ti task run subject to independent executor and project policies.", "ti_agent_run", (db, s, p, a) => s.tiAgentService.createRun(db, p, a)),
};
export function parseAssistantOperation(operationName: string, input: unknown) {
    const operation = assistantOperations[operationName];
    if (!operation || !Object.hasOwn(assistantOperations, operationName))
        throw new schemas.ValidationError("Unknown platform operation");
    return operation.schema.parse(input);
}
export const assistantOperationTools = Object.entries(assistantOperations).map(([name, operation]) => {
    const parameters = zodToJsonSchema(operation.schema, { $refStrategy: "none" });
    delete parameters.$schema;
    return { type: "function", function: { name, description: operation.description, parameters } };
});
export async function executeAssistantOperation(db: Database, services: Services, operationName: string, input: unknown, actor: Actor) {
    const operation = assistantOperations[operationName];
    const parsed = parseAssistantOperation(operationName, input);
    const result = await operation!.run(db, services, parsed, actor);
    const entityId = operation!.target ? parsed[operation!.target] : result?.id;
    return { entityType: operation!.kind, entityId, result: cleanAssistantToolData(result) };
}
