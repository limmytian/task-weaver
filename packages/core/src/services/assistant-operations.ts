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
    kind: "project" | "requirement" | "task" | "document" | "schedule" | "ti_agent_run";
    target?: string;
    run: (db: Database, services: Services, input: any, actor: Actor) => Promise<any>;
};
const uuid = z.string().uuid();
const id = (key: string) => z.object({ [key]: uuid }).strict();
const update = (key: string, schema: z.ZodTypeAny) => z.object({ [key]: uuid, changes: schema }).strict();
const operation = (schema: z.ZodTypeAny, description: string, kind: Operation["kind"], run: Operation["run"], target?: string): Operation => ({ schema, description, kind, run, target });
/** Same validated business services as REST/CLI; identity and actor are never model arguments. */
export const assistantOperations: Record<string, Operation> = {
    create_project: operation(schemas.createProjectSchema.strict(), "Create a project.", "project", (db, s, p, a) => s.projectService.createProject(db, p, a)),
    update_project: operation(update("projectId", schemas.updateProjectSchema), "Update project details or archive a project.", "project", (db, s, p, a) => s.projectService.updateProject(db, p.projectId, p.changes, a), "projectId"),
    archive_project: operation(id("projectId"), "Archive a project using normal CLI lifecycle rules.", "project", (db, s, p, a) => s.projectService.deleteProject(db, p.projectId, a), "projectId"),
    create_requirement: operation(schemas.createRequirementSchema.strict(), "Create a requirement under a project. Use the returned id to create tasks.", "requirement", (db, s, p, a) => s.requirementService.createRequirement(db, p, a)),
    update_requirement: operation(update("requirementId", schemas.updateRequirementSchema), "Update a requirement, including status, priority and model tier.", "requirement", (db, s, p, a) => s.requirementService.updateRequirement(db, p.requirementId, p.changes, a), "requirementId"),
    cancel_requirement: operation(id("requirementId"), "Cancel a requirement using normal CLI lifecycle rules.", "requirement", (db, s, p, a) => s.requirementService.deleteRequirement(db, p.requirementId, a), "requirementId"),
    create_task: operation(schemas.createTaskSchema, "Create a project task. projectId and requirementId are required. Use a real requirement id, never invent one.", "task", (db, s, p, a) => s.taskService.createTask(db, p, a)),
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
    delete_document: operation(id("documentId"), "Delete a document using normal CLI lifecycle rules.", "document", (db, s, p, a) => s.documentService.deleteDocument(db, p.documentId, a), "documentId"),
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
    if (!operation)
        throw new schemas.ValidationError("Unknown platform operation");
    return operation.schema.parse(input);
}
export function assistantOperationSchema(name: string) {
    const operation = assistantOperations[name];
    if (!operation)
        throw new schemas.ValidationError("Unknown platform operation");
    return { operation: name, description: operation.description, inputSchema: zodToJsonSchema(operation.schema, { $refStrategy: "none" }) };
}
export const assistantOperationTools = [
    { type: "function", function: { name: "platform_operation_schema", description: "Read the exact input schema before performing an operation. Available operations: " + Object.entries(assistantOperations).map(([name, value]) => name + ": " + value.description).join("; "), parameters: { type: "object", properties: { operation: { type: "string", enum: Object.keys(assistantOperations) } }, required: ["operation"], additionalProperties: false } } },
    { type: "function", function: { name: "platform_operation", description: "Execute a permitted platform operation. Read platform_operation_schema first. Chain returned ids to create requirements, tasks, dependencies and execution slices. Never invent ids. Each operation is audited and uses the signed-in account's permissions.", parameters: { type: "object", properties: { operation: { type: "string", enum: Object.keys(assistantOperations) }, input: { type: "object" } }, required: ["operation", "input"], additionalProperties: false } } },
];
export async function executeAssistantOperation(db: Database, services: Services, operationName: string, input: unknown, actor: Actor) {
    const operation = assistantOperations[operationName];
    const parsed = parseAssistantOperation(operationName, input);
    const result = await operation!.run(db, services, parsed, actor);
    const entityId = operation!.target ? parsed[operation!.target] : result?.id;
    return { entityType: operation!.kind, entityId, result };
}
