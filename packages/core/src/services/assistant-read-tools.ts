import { z } from "zod";
import type { Database } from "@task-weaver/db";
import { listProjectsSchema, listTasksSchema, listRequirementsSchema, listDocumentsSchema, type VerifiedRequestContext } from "@task-weaver/contracts";
import { createResourceServices } from "./resource-services";

export type AssistantReadReference = { kind: "project" | "requirement" | "task" | "document"; id: string };
const id = { type: "string", format: "uuid" };
const page = { type: "integer", minimum: 1 };
const query = { type: "string", maxLength: 500 };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

/** Only read tools are exposed. Mutations must use the separately authorized action flow. */
export const assistantReadTools = [
  definition("list_projects", "List projects accessible to the signed-in user. Returns exact total and paginated summaries; use query to find a named project.", { query, page, status: { type: "string", enum: ["active", "archived"] } }),
  definition("get_project", "Read an accessible project's details and live task/requirement statistics.", { projectId: id }, ["projectId"]),
  definition("list_tasks", "List accessible project tasks with pagination. Total is for the supplied filters; omit status to see all statuses.", { projectId: id, requirementId: id, query, page, status: { type: "string", enum: ["todo", "in_progress", "in_review", "done", "cancelled"] } }, ["projectId"]),
  definition("get_task", "Read one accessible task's details, dependencies, comments and notes.", { taskId: id }, ["taskId"]),
  definition("list_requirements", "List accessible project requirements with pagination and exact filtered total.", { projectId: id, query, page }, ["projectId"]),
  definition("list_execution_slices", "Read the requirement execution plan, task membership, order and parallelism.", { requirementId: id }, ["requirementId"]),
  definition("get_requirement", "Read one accessible requirement's current details.", { requirementId: id }, ["requirementId"]),
  definition("list_documents", "Find accessible documents by title query, optionally in a project, including this account's personal documents and accessible global documents.", { projectId: id, query, page }),
  definition("get_document", "Read an accessible document's content. Long content may be truncated.", { documentId: id }, ["documentId"]),
];

export async function runAssistantReadTool(db: Database, identity: VerifiedRequestContext, name: string, raw: unknown) {
  const service = createResourceServices(identity);
  const references: AssistantReadReference[] = [];
  const clean = (value: any): any => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    const truncated: Record<string, number> = {};
    const entries = Object.entries(value).filter(([key]) => key !== "repositories").map(([key, field]) => {
      if (["tasks", "dependencies", "dependents", "executionSlices", "documentLinks"].includes(key) && Array.isArray(field) && field.length > 20) {
        truncated[key] = field.length;
        return [key, clean(field.slice(0, 20))];
      }
      return [key, clean(field)];
    });
    return { ...Object.fromEntries(entries), ...(Object.keys(truncated).length ? { relatedDataTruncated: truncated } : {}) };
  };
  const record = (kind: AssistantReadReference["kind"], value: any): any => {
    const cleaned = clean(value);
    const rows = Array.isArray(cleaned) ? cleaned : cleaned?.items ?? [cleaned];
    for (const row of rows) {
      if (typeof row?.id === "string" && !references.some(reference => reference.kind === kind && reference.id === row.id)) references.push({ kind, id: row.id });
      if (row?.project) record("project", row.project);
      if (row?.requirement) record("requirement", row.requirement);
      for (const task of row?.tasks ?? []) record("task", task);
      for (const slice of row?.executionSlices ?? []) for (const task of slice.tasks ?? []) record("task", task);
      for (const link of row?.documentLinks ?? []) if (link.document) record("document", link.document);
      if (kind === "task" || kind === "requirement") {
        for (const dependency of row?.dependencies ?? []) if (dependency.dependsOn) record(kind, dependency.dependsOn);
        for (const dependent of row?.dependents ?? []) {
          const resource = kind === "task" ? dependent.task : dependent.requirement;
          if (resource) record(kind, resource);
        }
      }
    }
    return cleaned;
  };
  const singleId = (key: string) => z.object({ [key]: z.string().uuid() }).strict().parse(raw)[key]!;
  let data: unknown;
  switch (name) {
    case "list_projects": {
      const args = listProjectsSchema.pick({ query: true, page: true, status: true }).strict().parse(raw);
      data = record("project", await service.projectService.listProjects(db, { ...args, view: "summary", pageSize: 20 })); break;
    }
    case "get_project": {
      const projectId = singleId("projectId");
      const project = record("project", await service.projectService.getProject(db, projectId));
      data = { project, statistics: await service.projectService.getProjectStats(db, projectId) }; break;
    }
    case "list_tasks": {
      const args = z.object({ projectId: z.string().uuid(), requirementId: z.string().uuid().optional(), query: z.string().min(1).max(500).optional(), page: z.number().int().min(1).optional(), status: z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]).optional() }).strict().parse(raw);
      data = record("task", await service.taskService.listTasks(db, listTasksSchema.parse({ ...args, view: "summary", pageSize: 20, completedWithinDays: 0 }))); break;
    }
    case "get_task": data = record("task", await service.taskService.getTaskDetail(db, singleId("taskId"))); break;
    case "list_requirements": {
      const args = listRequirementsSchema.pick({ projectId: true, query: true, page: true }).strict().parse(raw);
      data = record("requirement", await service.requirementService.listRequirements(db, { ...args, view: "summary", pageSize: 20, completedWithinDays: 0 })); break;
    }
    case "list_execution_slices": {
      const requirementId = singleId("requirementId");
      record("requirement", await service.requirementService.getRequirement(db, requirementId));
      const slices = await service.requirementService.listExecutionSlices(db, requirementId);
      const bounded = clean(slices.slice(0, 20));
      for (const slice of bounded) record("task", slice.tasks);
      data = { items: bounded, total: slices.length }; break;
    }
    case "get_requirement": data = record("requirement", await service.requirementService.getRequirement(db, singleId("requirementId"))); break;
    case "list_documents": {
      const args = listDocumentsSchema.pick({ projectId: true, query: true, page: true }).strict().parse(raw);
      data = record("document", await service.documentService.listDocuments(db, { ...args, includeGlobal: true, includePersonal: true, view: "summary", pageSize: 20 })); break;
    }
    case "get_document": {
      const document = record("document", await service.documentService.getDocument(db, singleId("documentId"))) as any;
      data = { ...document, content: document.content?.slice(0, 8000), contentTruncated: (document.content?.length ?? 0) > 8000 }; break;
    }
    default: throw new Error("Unsupported assistant read tool");
  }
  return { data, references };
}
