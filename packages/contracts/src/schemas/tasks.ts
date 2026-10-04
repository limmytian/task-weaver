import { z } from "zod";
import { requirementLeaseFenceFields } from "./common";

export const taskStatusSchema = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const taskScopeSchema = z.enum(["project", "personal"]);

const baseCreateTaskSchema = z.object({
  scope: taskScopeSchema.default("project"),
  projectId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  executionSliceId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  title: z.string().min(1).max(500),
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
  ...requirementLeaseFenceFields,
});

export const createTaskSchema = baseCreateTaskSchema.superRefine((data, ctx) => {
  if (data.scope === "project") {
    if (!data.projectId) {
      ctx.addIssue({ code: "custom", path: ["projectId"], message: "Project tasks require projectId" });
    }
    if (!data.requirementId) {
      ctx.addIssue({ code: "custom", path: ["requirementId"], message: "Project tasks require requirementId" });
    }
    if (data.personalOwnerId || data.personalOwnerType) {
      ctx.addIssue({ code: "custom", path: ["personalOwnerId"], message: "Project tasks cannot set personal owner" });
    }
  } else {
    if (data.projectId || data.requirementId || data.executionSliceId) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "Personal tasks cannot belong to a project, requirement, or execution slice" });
    }
    if ((data.personalOwnerId && !data.personalOwnerType) || (!data.personalOwnerId && data.personalOwnerType)) {
      ctx.addIssue({ code: "custom", path: ["personalOwnerId"], message: "Personal owner id and type must be provided together" });
    }
  }
});

export const createPersonalTaskSchema = baseCreateTaskSchema
  .omit({
    scope: true,
    projectId: true,
    requirementId: true,
    executionSliceId: true,
    daemonId: true,
    leaseGeneration: true,
  })
  .extend({
    personalOwnerId: z.string().optional(),
    personalOwnerType: z.enum(["human", "agent"]).optional(),
  });

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  requirementId: z.string().uuid().optional(),
  executionSliceId: z.string().uuid().nullable().optional(),
  priority: taskPrioritySchema.optional(),
  assignee: z.string().nullable().optional(),
  assigneeType: z.enum(["human", "agent"]).nullable().optional(),
  requestedProvider: z.string().nullable().optional(),
  requestedModel: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  branchName: z.string().nullable().optional(),
  expectedAt: z.coerce.date().nullable().optional(),
  expectedVersion: z.number().int().positive().optional().describe(
    "Optimistic concurrency: update only if current version matches. Returns 409 on mismatch.",
  ),
});

export const updateTaskStatusSchema = z.object({
  status: taskStatusSchema,
  reason: z.string().optional(),
  force: z.boolean().default(false).describe(
    "If true, skip blocking-dependency check and allow status change even when blockers are not done.",
  ),
  ...requirementLeaseFenceFields,
});

export const claimTaskSchema = z.object({
  durationMinutes: z.number().int().min(1).max(1440).default(30).describe(
    "Lease duration in minutes (1–1440). Claim expires after this unless heartbeat refreshes it.",
  ),
});

export const releaseTaskSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const batchClaimTasksSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(20).describe(
    "Task IDs to claim. Atomic: all succeed or all fail — no partial claims.",
  ),
  durationMinutes: z.number().int().min(1).max(1440).default(30).describe(
    "Lease duration in minutes, applied uniformly to all claims.",
  ),
});

export const listTasksSchema = z.object({
  scope: taskScopeSchema.default("project"),
  projectId: z.string().uuid().optional(),
  personalOwnerId: z.string().optional(),
  personalOwnerType: z.enum(["human", "agent"]).optional(),
  requirementId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  assignee: z.string().optional(),
  priority: taskPrioritySchema.optional(),
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
      "For terminal-status tasks (done/cancelled), only return those completed within this many days. Default 14. Set 0 to return all.",
    ),
}).superRefine((data, ctx) => {
  if (data.scope === "project" && !data.projectId) {
    ctx.addIssue({ code: "custom", path: ["projectId"], message: "Project task listing requires projectId" });
  }
  if (data.scope === "personal" && ((data.personalOwnerId && !data.personalOwnerType) || (!data.personalOwnerId && data.personalOwnerType))) {
    ctx.addIssue({ code: "custom", path: ["personalOwnerId"], message: "Personal owner id and type must be provided together" });
  }
});



export const createTaskCommentSchema = z.object({
  content: z.string().min(1),
});

export const createTaskNoteSchema = z.object({
  content: z.string().min(1),
  pinned: z.boolean().default(false),
});

export const createTaskDependencySchema = z.object({
  dependsOnTaskId: z.string().uuid(),
  type: z.enum(["blocks", "related"]).default("blocks"),
  description: z.string().max(500).optional(),
});

export const batchCreateTasksSchema = z.object({
  tasks: z.array(createTaskSchema).min(1).max(50),
});

export const batchUpdateTasksSchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: taskStatusSchema.optional(),
        reason: z.string().optional(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        priority: taskPrioritySchema.optional(),
        assignee: z.string().nullable().optional(),
        requestedPiProvider: z.string().nullable().optional(),
        requestedPiModel: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskScope = z.infer<typeof taskScopeSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type CreatePersonalTaskInput = z.input<typeof createPersonalTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>;
export type ListTasksInput = z.input<typeof listTasksSchema>;
export type BatchCreateTasksInput = z.infer<typeof batchCreateTasksSchema>;
export type BatchUpdateTasksInput = z.infer<typeof batchUpdateTasksSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;
export type BatchClaimTasksInput = z.infer<typeof batchClaimTasksSchema>;
