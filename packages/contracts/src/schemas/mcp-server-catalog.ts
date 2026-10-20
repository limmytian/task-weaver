import { mcpRetrievalScopeSchema, mcpPackageFilesSchema, mcpPackageReadSchema, mcpSliceCreateSchema, mcpSliceUpdateSchema, mcpPlanValidateSchema, mcpPlanApplySchema, mcpAggregateContextSchema } from "./mcp-server-planning";
import { z } from "zod";
import { resolveSkillCapabilitiesSchema, runSkillCapabilitySchema } from "./capabilities";
import { mcpMemorySearchSchema, mcpMemoryGetSchema, mcpMemoryRecordSchema, mcpMemoryUpdateSchema, mcpMemoryForgetSchema, mcpMemoryPreviewSchema } from "./mcp-memory";
import { listProjectsSchema } from "./projects";
import { createRequirementSchema, updateRequirementSchema, listRequirementsSchema, createRequirementDependencySchema, linkDocumentToRequirementSchema } from "./requirements";
import { createTaskSchema, createPersonalTaskSchema, updateTaskSchema, updateTaskStatusSchema, claimTaskSchema, releaseTaskSchema, createTaskCommentSchema, createTaskDependencySchema } from "./tasks";
import { createDocumentSchema, updateDocumentSchema, listDocumentsSchema, linkDocumentToTaskSchema } from "./documents";
import { mcpServerPageSchema, mcpServerReadTools, type McpServerToolName } from "./mcp-server";

const id = z.string().uuid();
const byId = z.object({ id }).strict();
const page = mcpServerPageSchema.shape;
const taskFields = createPersonalTaskSchema.omit({ personalOwnerId: true, personalOwnerType: true, requestedProvider: true, requestedModel: true, branchName: true }).strict();
const taskCreate = taskFields.extend({ scope: z.enum(["project", "personal"]).default("project"), projectId: id.optional(), requirementId: id.optional(), executionSliceId: id.optional() }).strict();
const taskList = z.object({ ...page, scope: z.enum(["project", "personal"]).default("project"), projectId: id.optional(), requirementId: id.optional(), status: updateTaskStatusSchema.shape.status.optional(), query: z.string().trim().min(1).max(500).optional(), assignee: z.string().optional() }).strict();
const search = z.object({ query: z.string().trim().min(1).max(500), projectId: id.optional(), scope: z.enum(["project", "personal"]).default("project"), entity: z.enum(["all", "task", "requirement", "document"]).default("all"), mode: z.enum(["keyword", "fulltext", "semantic", "hybrid"]).default("keyword"), limit: z.number().int().min(1).max(50).default(20), includeGlobal: z.boolean().default(true) }).strict();

function tool(name: McpServerToolName, description: string, schema: z.AnyZodObject) {
  return { name, description, schema: (mcpServerReadTools as readonly string[]).includes(name) ? schema : schema.extend({ approvalId: id.optional() }).strict() };
}

/** One catalog for both transports. Business refinements are applied again before dispatch. */
export const mcpServerCatalog = [
  tool("tw_projects_discover", "Search bounded project directory metadata; does not grant project content access.", listProjectsSchema.omit({ view: true }).extend(page).strict()),
  tool("tw_projects_list", "List visible projects with compact pagination.", listProjectsSchema.extend(page).extend({ view: z.literal("summary").default("summary") }).strict()),
  tool("tw_projects_get", "Read one authorized project by id.", byId),
  tool("tw_requirements_list", "List requirements in an authorized project.", listRequirementsSchema.extend(page).extend({ view: z.literal("summary").default("summary") }).strict()),
  tool("tw_requirements_get", "Read one requirement without loading its task history.", byId),
  tool("tw_requirements_create", "Create a requirement; does not execute or integrate work.", createRequirementSchema.omit({ workflow: true, workflowPreset: true, branchName: true }).strict()),
  tool("tw_requirements_update", "Update a requirement using existing workflow guards.", z.object({ id, patch: updateRequirementSchema.omit({ workflow: true, workflowPreset: true, leaseGeneration: true, daemonId: true, branchName: true }).strict() }).strict()),
  tool("tw_requirement_dependencies_list", "List a requirement's upstream dependency links.", byId.extend(page).strict()),
  tool("tw_requirement_dependencies_add", "Add a same-project requirement dependency.", createRequirementDependencySchema.extend({ id }).strict()),
  tool("tw_requirement_dependencies_remove", "Remove a dependency belonging to the supplied requirement.", z.object({ id, dependencyId: id }).strict()),
  tool("tw_tasks_list", "List project tasks or the credential owner's personal tasks.", taskList),
  tool("tw_tasks_get", "Read one task without loading comments and history.", byId),
  tool("tw_tasks_create", "Create a project task under a requirement or a personal task.", taskCreate),
  tool("tw_tasks_update", "Update task fields; supply expectedVersion to detect concurrent changes.", z.object({ id, patch: updateTaskSchema.omit({ requestedProvider: true, requestedModel: true, branchName: true }).strict() }).strict()),
  tool("tw_tasks_status", "Change task status with dependency and workflow guards; cannot force completion.", updateTaskStatusSchema.omit({ force: true, leaseGeneration: true, daemonId: true }).extend({ id }).strict()),
  tool("tw_tasks_claim", "Claim a task for the verified credential owner.", claimTaskSchema.extend({ id }).strict()),
  tool("tw_tasks_heartbeat", "Renew the verified owner's task claim.", z.object({ id, extendMinutes: z.number().int().min(1).max(1440).default(30) }).strict()),
  tool("tw_tasks_release", "Release the verified owner's task claim.", releaseTaskSchema.extend({ id }).strict()),
  tool("tw_task_comments_list", "Read a bounded page of task comments.", byId.extend(page).strict()),
  tool("tw_task_comments_add", "Append a comment attributed to the verified owner.", createTaskCommentSchema.extend({ id }).strict()),
  tool("tw_task_dependencies_list", "Read a bounded page of upstream task dependency links.", byId.extend(page).strict()),
  tool("tw_task_dependencies_add", "Add a task dependency within the same resource scope.", createTaskDependencySchema.extend({ id }).strict()),
  tool("tw_task_dependencies_remove", "Remove a dependency belonging to the supplied task.", z.object({ id, dependencyId: id }).strict()),
  tool("tw_documents_list", "List authorized document metadata with compact pagination.", listDocumentsSchema.omit({ personalOwnerId: true, personalOwnerType: true }).extend(page).extend({ view: z.literal("summary").default("summary") }).strict()),
  tool("tw_documents_get", "Read authorized document metadata and Markdown content.", byId),
  tool("tw_documents_create", "Create a Markdown document in authorized project, global or personal scope.", createDocumentSchema.omit({ personalOwnerId: true, personalOwnerType: true, generatedBy: true, generationPrompt: true }).extend({ scope: z.enum(["project", "global", "personal"]).optional() }).strict()),
  tool("tw_documents_update", "Update Markdown using expectedVersion for concurrent change detection.", z.object({ id, patch: updateDocumentSchema.omit({ personalOwnerId: true, personalOwnerType: true, projectId: true, generatedBy: true, generationPrompt: true }).strict() }).strict()),
  tool("tw_document_task_links_add", "Link an authorized document to an authorized task.", linkDocumentToTaskSchema.extend({ id }).strict()),
  tool("tw_document_requirement_links_add", "Link an authorized document to an authorized requirement.", linkDocumentToRequirementSchema.extend({ id }).strict()),
  tool("tw_context_bootstrap", "Read Task Weaver MCP collaboration conventions and discovery guidance.", z.object({}).strict()),
  tool("tw_memories_search", "Discover bounded memory summaries without renewing expiry; read full content separately.", mcpMemorySearchSchema),
  tool("tw_memories_preview", "Preview a bounded source-derived memory candidate without writing; review and explicitly save it separately.", mcpMemoryPreviewSchema),
  tool("tw_memories_get", "Read one authorized active memory and its revision/provenance.", mcpMemoryGetSchema),
  tool("tw_memories_record", "Explicitly save a confirmed memory; reuse the same key and payload after an ambiguous response.", mcpMemoryRecordSchema),
  tool("tw_memories_update", "Revise a memory using its exact current version.", mcpMemoryUpdateSchema),
  tool("tw_memories_forget", "Explicitly forget a memory at its current version; old save retries cannot restore it.", mcpMemoryForgetSchema),
  tool("tw_context_search", "Discover authorized skill summaries by intent; read full text separately.", mcpRetrievalScopeSchema.extend({ intent: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(5) }).strict()),
  tool("tw_context_get", "Read one authorized skill document; use expectedVersion for a pinned dependency.", byId.extend({ expectedVersion: z.number().int().min(1).optional() }).strict()),
  tool("tw_skill_packages_resolve", "Resolve a bounded, permission-checked graph of exact skill and tool dependencies without loading their bodies or executing them.", resolveSkillCapabilitiesSchema),
  tool("tw_skill_runtimes_list", "Inspect operator-configured digest-pinned isolated runtime profiles and readiness.", z.object({}).strict()),
  tool("tw_skills_run", "Explicitly execute a pinned skill in a configured isolated container without network or inherited credentials; requires resource.write and mcp.invoke.", runSkillCapabilitySchema),
  tool("tw_skill_packages_list", "List authorized skill package summaries.", mcpRetrievalScopeSchema.extend({ query: z.string().trim().min(1).max(500).optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict()),
  tool("tw_skill_packages_get", "Read safe package metadata without storage locations or recursive files.", z.object({ packageId: id }).strict()),
  tool("tw_skill_package_files", "List a bounded page of package file metadata.", mcpPackageFilesSchema),
  tool("tw_skill_package_read", "Read one bounded readable package text file by relative path.", mcpPackageReadSchema),
  tool("tw_execution_slices_list", "List a bounded page of requirement slice summaries.", byId.extend(page).strict()),
  tool("tw_execution_slices_create", "Create a requirement slice with guarded task assignment.", z.object({ id, input: mcpSliceCreateSchema }).strict()),
  tool("tw_execution_slices_update", "Update a slice using expectedUpdatedAt for concurrent change detection.", z.object({ id, expectedUpdatedAt: z.string().datetime(), patch: mcpSliceUpdateSchema }).strict()),
  tool("tw_plan_validate", "Validate and preview a project plan without writes; checks write authority.", mcpPlanValidateSchema),
  tool("tw_plan_apply", "Atomically apply a bounded project plan; retry with the same key and identical plan.", mcpPlanApplySchema),
  tool("tw_tasks_context", "Read selected bounded task context sections; reports truncation and non-snapshot freshness.", mcpAggregateContextSchema),
  tool("tw_requirements_context", "Read selected bounded requirement context sections; reports truncation and non-snapshot freshness.", mcpAggregateContextSchema),
  tool("tw_search", "Search authorized tasks, requirements and documents; results have a total bound, not page counts.", search),
] as const;

export function parseMcpServerArguments(name: McpServerToolName, value: unknown): Record<string, unknown> {
  const definition = mcpServerCatalog.find(tool => tool.name === name)!;
  const input = definition.schema.parse(value);
  if (name === "tw_tasks_create") return { ...createTaskSchema.parse(input), ...(input.approvalId ? { approvalId: input.approvalId } : {}) };
  if (name === "tw_documents_create" || name === "tw_memories_record" || name === "tw_memories_preview" || name === "tw_skills_run") {
    if ((input.scope === "project" && !input.projectId) || ((input.scope === "personal" || input.scope === "global") && input.projectId)) {
      throw new z.ZodError([{ code: "custom", path: ["scope"], message: "Document scope conflicts with projectId" }]);
    }
  }
  if (name === "tw_tasks_list" || name === "tw_search") {
    const scoped = input as z.infer<typeof taskList>;
    if (scoped.scope === "project" && !scoped.projectId && name === "tw_tasks_list") {
      throw new z.ZodError([{ code: "custom", path: ["projectId"], message: "Project task listing requires projectId" }]);
    }
    if (scoped.scope === "personal" && (scoped.projectId || scoped.requirementId)) {
      throw new z.ZodError([{ code: "custom", path: ["scope"], message: "Personal scope cannot select a project or requirement" }]);
    }
  }
  return input;
}
