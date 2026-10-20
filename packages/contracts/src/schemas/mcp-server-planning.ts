import { z } from "zod";
import { planSchema, planDocumentSchema, planRequirementSchema, planTaskSchema, planSliceSchema } from "./plans";
import { createExecutionSliceSchema, updateExecutionSliceSchema } from "./requirements";
import { skillPackagePathSchema } from "./skill-packages";

const id = z.string().uuid();
export const mcpRetrievalScopeSchema = z.object({
  projectId: id.optional(), includeGlobal: z.boolean().default(true),
  includePersonal: z.boolean().default(false),
}).strict();
export const mcpPackageFilesSchema = z.object({
  packageId: id, version: z.string().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export const mcpPackageReadSchema = mcpPackageFilesSchema.omit({ offset: true, limit: true }).extend({ path: skillPackagePathSchema }).strict();
export const mcpSliceCreateSchema = createExecutionSliceSchema.extend({
  taskIds: z.array(id).max(50).optional(),
}).strict();
export const mcpSliceUpdateSchema = updateExecutionSliceSchema.omit({ leaseGeneration: true, daemonId: true }).extend({
  taskIds: z.array(id).max(50).optional(),
}).strict();

// Plans cannot expand the authority exposed by individual MCP writes.
const document = planDocumentSchema.innerType().omit({ projectId: true, generatedBy: true, generationPrompt: true, confidence: true, needsReview: true }).strict();
const task = planTaskSchema.innerType().omit({ requestedProvider: true, requestedModel: true, branchName: true, assignee: true, assigneeType: true, comments: true, notes: true }).extend({ status: z.literal("todo").default("todo") }).strict();
const requirement = planRequirementSchema.innerType().omit({ workflow: true, workflowPreset: true, branchName: true }).extend({
  status: z.enum(["draft", "approved"]).default("draft"),
  tasks: z.array(task).max(50).default([]),
  slices: z.array(planSliceSchema.strict()).max(20).default([]),
}).strict();
export const mcpPlanSchema = planSchema.extend({
  documents: z.array(document).max(20).default([]),
  requirements: z.array(requirement).max(10).default([]),
}).strict().superRefine((plan, ctx) => {
  let nodes = 0;
  function visit(value: unknown, path: Array<string | number>) {
    if (!value || typeof value !== "object") return;
    nodes++;
    if (Array.isArray(value)) {
      if (value.length > 100) ctx.addIssue({ code: "custom", path, message: "Plan arrays support at most 100 entries" });
      value.forEach((item, index) => visit(item, [...path, index]));
    } else for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  }
  visit(plan, []);
  if (nodes > 2000) ctx.addIssue({ code: "custom", path: [], message: "Plan graph exceeds the complexity limit" });
  const count = plan.requirements.reduce((sum, item) => sum + item.tasks.length, 0);
  if (count > 100) ctx.addIssue({ code: "custom", path: ["requirements"], message: "A plan supports at most 100 tasks" });
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
});
export const mcpPlanValidateSchema = z.object({ plan: mcpPlanSchema }).strict();
export const mcpPlanApplySchema = mcpPlanValidateSchema.extend({ idempotencyKey: z.string().uuid() }).strict();
export const mcpAggregateContextSchema = z.object({
  id,
  sections: z.array(z.enum(["parent", "tasks", "slices", "dependencies", "documents", "claim", "activity", "comments", "notes"])).max(9)
    .default(["parent", "dependencies", "documents", "claim"]),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(100000).default(0),
  maxBytes: z.number().int().min(2048).max(65536).default(32768),
}).strict();

export const mcpDependencyGraphSchema = z.object({
  id, kind: z.enum(["task", "requirement"]),
  maxDepth: z.number().int().min(1).max(4).default(2),
  maxNodes: z.number().int().min(1).max(50).default(20),
  maxEdges: z.number().int().min(1).max(100).default(40),
  maxBytes: z.number().int().min(2048).max(32768).default(16384),
}).strict();

export const mcpDocumentHistorySchema = z.object({
  id, offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
export const mcpDocumentVersionSchema = z.object({
  id, version: z.number().int().min(1).max(2147483647),
  offset: z.number().int().min(0).max(10000000).default(0),
  limit: z.number().int().min(1).max(8000).default(4000),
}).strict();

export const mcpRepositoryListSchema = z.object({
  scope: z.enum(["global", "personal"]).default("personal"),
  query: z.string().trim().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
export const mcpScheduleListSchema = z.object({
  scope: z.enum(["project", "personal"]).default("project"),
  projectId: id.optional(),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
export const mcpUsageSummarySchema = z.object({
  projectId: id, requirementId: id.optional(), taskId: id.optional(),
  since: z.string().datetime().optional(), until: z.string().datetime().optional(),
}).strict();
