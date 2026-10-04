import { z } from "zod";
import { docTypeSchema } from "./documents";
import {
  modelTierSchema,
  requirementPrioritySchema,
  requirementStatusSchema,
} from "./requirements";
import { taskPrioritySchema, taskStatusSchema } from "./tasks";

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
  expectedAt: z.coerce.date().optional(),
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
  expectedAt: z.coerce.date().optional(),
  dependsOn: z.array(planRequirementDependencySchema).default([]),
  dependencies: z.array(planRequirementDependencySchema).default([]),
  documents: z.array(planDocumentRefSchema).default([]),
  slices: z.array(planSliceSchema).default([]),
  tasks: z.array(planTaskSchema).default([]),
}).superRefine((data, ctx) => {
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
