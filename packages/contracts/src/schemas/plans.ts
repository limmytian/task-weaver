import { z } from "zod";
import { docTypeSchema } from "./documents";
import {
  executionRecoveryPolicySchema,
  modelTierSchema,
  requirementPrioritySchema,
  requirementStatusSchema,
} from "./requirements";
import { taskPrioritySchema, taskStatusSchema } from "./tasks";
import { requirementWorkflowSchema, workflowPresetSchema } from "./workflows";

const keySchema = z.string().min(1).max(120);
const refSchema = z.string().min(1).max(500);
const dependencyTypeSchema = z.enum(["blocks", "related"]);
const entityLinkTypeSchema = z.enum(["references", "documents", "output"]);
const documentLinkTypeSchema = z.enum(["reference", "related", "parent"]);

export const planDocumentRefSchema = z.union([
  refSchema,
  z.object({
    document: refSchema,
    type: entityLinkTypeSchema.default("references"),
  }),
]);

export const planDocumentLinkSchema = z.object({
  source: refSchema,
  target: refSchema,
  type: documentLinkTypeSchema.default("reference"),
  context: z.string().optional(),
});

export const planTaskDependencySchema = z.union([
  refSchema,
  z.object({
    task: refSchema,
    type: dependencyTypeSchema.default("blocks"),
    description: z.string().max(500).optional(),
  }),
]);

export const planRequirementDependencySchema = z.union([
  refSchema,
  z.object({
    requirement: refSchema,
    type: dependencyTypeSchema.default("blocks"),
    description: z.string().max(500).optional(),
  }),
]);

export const planCommentSchema = z.union([
  z.string().min(1),
  z.object({ content: z.string().min(1) }),
]);

export const planNoteSchema = z.union([
  z.string().min(1),
  z.object({
    content: z.string().min(1),
    pinned: z.boolean().default(false),
  }),
]);

export const planDocumentSchema = z.object({
  key: keySchema,
  existingId: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  content: z.string().optional(),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  docType: docTypeSchema.optional(),
  language: z.string().max(10).optional(),
  generatedBy: z.string().optional(),
  generationPrompt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().optional(),
  links: z.array(
    z.object({
      document: refSchema,
      type: documentLinkTypeSchema.default("reference"),
      context: z.string().optional(),
    }),
  ).default([]),
}).superRefine((data, ctx) => {
  if (!data.existingId) {
    if (!data.title) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "New documents require title" });
    }
    if (data.content === undefined) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "New documents require content" });
    }
  }
});

export const planTaskSchema = z.object({
  key: keySchema,
  existingId: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: taskStatusSchema.default("todo"),
  priority: taskPrioritySchema.default("medium"),
  assignee: z.string().optional(),
  assigneeType: z.enum(["human", "agent"]).optional(),
  requestedProvider: z.string().optional(),
  requestedModel: z.string().optional(),
  tags: z.array(z.string()).optional(),
  branchName: z.string().optional(),
  expectedAt: z.coerce.date<Date>().optional(),
  slice: refSchema.optional(),
  dependsOn: z.array(planTaskDependencySchema).default([]),
  dependencies: z.array(planTaskDependencySchema).default([]),
  documents: z.array(planDocumentRefSchema).default([]),
  comments: z.array(planCommentSchema).default([]),
  notes: z.array(planNoteSchema).default([]),
}).superRefine((data, ctx) => {
  if (!data.existingId && !data.title) {
    ctx.addIssue({ code: "custom", path: ["title"], message: "New tasks require title" });
  }
});

export const planSliceSchema = z.object({
  key: keySchema,
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  orderIndex: z.number().int().min(0).optional(),
  allowParallel: z.boolean().default(false),
  modelTier: modelTierSchema.optional(),
  tasks: z.array(refSchema).default([]),
});

export const planRequirementSchema = z.object({
  key: keySchema,
  existingId: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: requirementStatusSchema.default("draft"),
  priority: requirementPrioritySchema.default("medium"),
  modelTier: modelTierSchema.default("standard"),
  tags: z.array(z.string()).optional(),
  branchName: z.string().optional(),
  expectedAt: z.coerce.date<Date>().optional(),
  recoveryPolicy: executionRecoveryPolicySchema.optional(),
  workflowPreset: workflowPresetSchema.optional(),
  workflow: requirementWorkflowSchema.optional(),
  dependsOn: z.array(planRequirementDependencySchema).default([]),
  dependencies: z.array(planRequirementDependencySchema).default([]),
  documents: z.array(planDocumentRefSchema).default([]),
  slices: z.array(planSliceSchema).default([]),
  tasks: z.array(planTaskSchema).default([]),
}).superRefine((data, ctx) => {
  if (data.workflow && data.workflowPreset) ctx.addIssue({ code: "custom", path: ["workflow"], message: "Specify either a workflow or a workflow preset" });
  if (!data.existingId && ["in_review", "ready_to_merge", "done"].includes(data.status)) ctx.addIssue({ code: "custom", path: ["status"], message: "New requirements must start before acceptance" });
  if (!data.existingId && !data.title) {
    ctx.addIssue({ code: "custom", path: ["title"], message: "New requirements require title" });
  }
});

export const planTaskDependencyLinkSchema = z.object({
  task: refSchema,
  dependsOn: refSchema,
  type: dependencyTypeSchema.default("blocks"),
  description: z.string().max(500).optional(),
});

export const planRequirementDependencyLinkSchema = z.object({
  requirement: refSchema,
  dependsOn: refSchema,
  type: dependencyTypeSchema.default("blocks"),
  description: z.string().max(500).optional(),
});

export const planDocumentTaskLinkSchema = z.object({
  document: refSchema,
  task: refSchema,
  type: entityLinkTypeSchema.default("references"),
});

export const planDocumentRequirementLinkSchema = z.object({
  document: refSchema,
  requirement: refSchema,
  type: entityLinkTypeSchema.default("references"),
});

export const planSchema = z.object({
  projectId: z.string().uuid(),
  documents: z.array(planDocumentSchema).default([]),
  requirements: z.array(planRequirementSchema).default([]),
  requirementDependencies: z.array(planRequirementDependencyLinkSchema).default([]),
  taskDependencies: z.array(planTaskDependencyLinkSchema).default([]),
  documentLinks: z.array(planDocumentLinkSchema).default([]),
  documentTaskLinks: z.array(planDocumentTaskLinkSchema).default([]),
  documentRequirementLinks: z.array(planDocumentRequirementLinkSchema).default([]),
});

export const applyPlanSchema = z.object({
  dryRun: z.boolean().default(false),
  plan: planSchema,
});

export type PlanInput = z.infer<typeof planSchema>;
export type ApplyPlanInput = z.infer<typeof applyPlanSchema>;
export type PlanTaskInput = z.infer<typeof planTaskSchema>;
export type PlanRequirementInput = z.infer<typeof planRequirementSchema>;
export type PlanDocumentInput = z.infer<typeof planDocumentSchema>;
export type PlanTaskDependencyInput = z.infer<typeof planTaskDependencySchema>;
export type PlanRequirementDependencyInput = z.infer<typeof planRequirementDependencySchema>;
export type PlanDocumentRefInput = z.infer<typeof planDocumentRefSchema>;
export type PlanCommentInput = z.infer<typeof planCommentSchema>;
export type PlanNoteInput = z.infer<typeof planNoteSchema>;

/** Limits for interactive staging; direct plan submission keeps its existing contract. */
export const stagedPlanSchema = planSchema.superRefine((plan, ctx) => {
  const tasks = plan.requirements.flatMap((requirement) => requirement.tasks);
  const slices = plan.requirements.flatMap((requirement) => requirement.slices);
  const edges = plan.taskDependencies.length + plan.requirementDependencies.length
    + plan.requirements.reduce((sum, requirement) => sum + requirement.dependsOn.length + requirement.dependencies.length, 0)
    + tasks.reduce((sum, task) => sum + task.dependsOn.length + task.dependencies.length, 0);
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 1024 * 1024) ctx.addIssue({ code: "custom", message: "Plan exceeds the 1 MiB limit" });
  if (plan.requirements.length > 100 || plan.documents.length > 100 || tasks.length > 200 || slices.length > 20 || edges > 500) {
    ctx.addIssue({ code: "custom", message: "Plan exceeds the staging entity or dependency limit" });
  }
  for (const [documentIndex, document] of plan.documents.entries()) {
    if (document.projectId !== undefined && document.projectId !== plan.projectId) {
      ctx.addIssue({ code: "custom", path: ["documents", documentIndex, "projectId"], message: "Staged documents must stay within the project" });
    }
  }
  for (const [requirementIndex, requirement] of plan.requirements.entries()) {
    if (!requirement.existingId && requirement.status !== "draft") ctx.addIssue({ code: "custom", path: ["requirements", requirementIndex, "status"], message: "Staged new requirements must start as draft" });
    for (const [taskIndex, task] of requirement.tasks.entries()) {
      if (!task.existingId && task.status !== "todo") ctx.addIssue({ code: "custom", path: ["requirements", requirementIndex, "tasks", taskIndex, "status"], message: "Staged new tasks must start as todo" });
    }
  }
});
export const createPlanDraftSchema = z.object({ plan: stagedPlanSchema, source: z.enum(["web", "assistant", "mcp"]) });
export const updatePlanDraftSchema = z.object({ projectId: z.string().uuid(), revision: z.number().int().positive(), plan: stagedPlanSchema });
export type CreatePlanDraftInput = z.infer<typeof createPlanDraftSchema>;
export type UpdatePlanDraftInput = z.infer<typeof updatePlanDraftSchema>;
