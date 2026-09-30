import { z } from "zod";
import { requirementLeaseFenceFields } from "./common";

export const requirementStatusSchema = z.enum([
  "draft",
  "approved",
  "in_progress",
  "in_review",
  "ready_to_merge",
  "done",
  "cancelled",
  "archived",
]);

export const requirementPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const modelTierSchema = z.enum(["fast", "standard", "strong"]);

export const executionSliceStatusSchema = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const createRequirementSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  status: requirementStatusSchema.default("draft"),
  priority: requirementPrioritySchema.default("medium"),
  modelTier: modelTierSchema.default("standard"),
  tags: z.array(z.string()).optional(),
  branchName: z.string().optional(),
  expectedAt: z.coerce.date().optional(),
});

export const updateRequirementSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: requirementStatusSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  modelTier: modelTierSchema.optional(),
  tags: z.array(z.string()).optional(),
  branchName: z.string().nullable().optional(),
  expectedAt: z.coerce.date().nullable().optional(),
  ...requirementLeaseFenceFields,
});

export const listRequirementsSchema = z.object({
  projectId: z.string().uuid(),
  status: requirementStatusSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  tag: z.string().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  view: z.enum(["summary", "full"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  completedWithinDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "For terminal-status requirements (done/cancelled/archived), only return those completed within this many days. Default 14. Set 0 to return all.",
    ),
});



export const linkDocumentToRequirementSchema = z.object({
  documentId: z.string().uuid(),
  linkType: z
    .enum(["references", "documents", "output"])
    .default("references"),
});

export const createRequirementDependencySchema = z.object({
  dependsOnRequirementId: z.string().uuid(),
  type: z.enum(["blocks", "related"]).default("blocks"),
  description: z.string().max(500).optional(),
});

export const createExecutionSliceSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  orderIndex: z.number().int().min(0).optional(),
  allowParallel: z.boolean().default(false),
  modelTier: modelTierSchema.optional(),
  taskIds: z.array(z.string().uuid()).optional(),
});

export const updateExecutionSliceSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  orderIndex: z.number().int().min(0).optional(),
  allowParallel: z.boolean().optional(),
  modelTier: modelTierSchema.optional(),
  status: executionSliceStatusSchema.optional(),
  resultSummary: z.string().nullable().optional(),
  taskIds: z.array(z.string().uuid()).optional(),
  ...requirementLeaseFenceFields,
});

export const batchCreateRequirementsSchema = z.object({
  requirements: z.array(createRequirementSchema).min(1).max(50),
});

export const claimRequirementSchema = z.object({
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(30),
  daemonId: z.string().uuid().optional(),
  workerIndex: z.union([z.string(), z.number()]).optional(),
});

export const releaseRequirementSchema = z.object({
  reason: z.string().optional(),
  ...requirementLeaseFenceFields,
});

export const heartbeatRequirementClaimSchema = z.object({
  extendMinutes: z.number().int().min(1).max(1440).default(30),
  ...requirementLeaseFenceFields,
});

export type RequirementStatus = z.infer<typeof requirementStatusSchema>;
export type RequirementPriority = z.infer<typeof requirementPrioritySchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
export type ExecutionSliceStatus = z.infer<typeof executionSliceStatusSchema>;
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;
export type ListRequirementsInput = z.infer<typeof listRequirementsSchema>;
export type BatchCreateRequirementsInput = z.infer<typeof batchCreateRequirementsSchema>;
export type ClaimRequirementInput = z.infer<typeof claimRequirementSchema>;
export type ReleaseRequirementInput = z.infer<typeof releaseRequirementSchema>;
export type HeartbeatRequirementClaimInput = z.infer<typeof heartbeatRequirementClaimSchema>;
export type CreateRequirementDependencyInput = z.infer<typeof createRequirementDependencySchema>;
export type CreateExecutionSliceInput = z.infer<typeof createExecutionSliceSchema>;
export type UpdateExecutionSliceInput = z.infer<typeof updateExecutionSliceSchema>;
