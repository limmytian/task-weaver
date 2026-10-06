import { z } from "zod";

export const scheduleKindSchema = z.enum(["one_off", "recurring"]);
export const scheduleTargetScopeSchema = z.enum(["project", "personal"]);
export const scheduleRecurrenceSyntaxSchema = z.enum(["rrule", "cron"]);
export const scheduleStatusSchema = z.enum(["active", "paused", "archived"]);
export const scheduleRunStatusSchema = z.enum([
  "pending",
  "created",
  "skipped",
  "failed",
  "cancelled",
]);
export const scheduleCatchUpPolicySchema = z.enum(["none", "latest", "all"]);

export const taskTemplatePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const scheduleTaskTemplateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  priority: taskTemplatePrioritySchema.default("medium"),
});

const scheduleBaseSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  requirementId: z.string().uuid().nullable().optional(),
  personalOwnerId: z.string().uuid().nullable().optional(),
  personalOwnerType: z.enum(["human", "agent"]).nullable().optional(),
  targetScope: scheduleTargetScopeSchema.default("project"),
  kind: scheduleKindSchema,
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  timezone: z.string().min(1).max(100).default("UTC"),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  nextRunAt: z.coerce.date().optional(),
  recurrenceSyntax: scheduleRecurrenceSyntaxSchema.optional(),
  recurrenceRule: z.string().min(1).max(2000).optional(),
  catchUpPolicy: scheduleCatchUpPolicySchema.default("latest"),
  expiryWindowMinutes: z.number().int().positive().nullable().optional(),
  maxCatchUpRuns: z.number().int().positive().max(500).nullable().optional(),
  taskTemplate: scheduleTaskTemplateSchema,
  autoRun: z.boolean().default(false),
  assignedExecutor: z.string().optional(),
  assignedExecutorType: z.enum(["human", "agent"]).optional(),
  requestedProvider: z.string().optional(),
  requestedModel: z.string().optional(),
});

const validateScheduleShape = (
  value: Partial<z.infer<typeof scheduleBaseSchema>>,
  ctx: z.RefinementCtx,
) => {
  if (value.targetScope === "project" && !value.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "projectId is required for project-scoped schedules",
    });
  }
  if (value.kind === "recurring" && (!value.recurrenceSyntax || !value.recurrenceRule)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recurrenceRule"],
      message: "recurring schedules require recurrenceSyntax and recurrenceRule",
    });
  }
  if (value.kind === "one_off" && (value.recurrenceSyntax || value.recurrenceRule)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recurrenceRule"],
      message: "one-off schedules must not define a recurrence rule",
    });
  }
};

export const createScheduleSchema = scheduleBaseSchema.superRefine(validateScheduleShape);

export const updateScheduleSchema = scheduleBaseSchema
  .partial()
  .extend({
    status: scheduleStatusSchema.optional(),
  })
  .superRefine(validateScheduleShape);

export const createScheduleRunSchema = z.object({
  scheduleId: z.string().uuid(),
  plannedFor: z.coerce.date(),
  status: scheduleRunStatusSchema.default("pending"),
  generatedTaskId: z.string().uuid().optional(),
  skippedReason: z.string().max(1000).optional(),
  errorMessage: z.string().max(4000).optional(),
  requestedProvider: z.string().optional(),
  requestedModel: z.string().optional(),
  actualProvider: z.string().optional(),
  actualModel: z.string().optional(),
});

export const updateScheduleRunSchema = z.object({
  status: scheduleRunStatusSchema.optional(),
  generatedTaskId: z.string().uuid().nullable().optional(),
  skippedReason: z.string().max(1000).nullable().optional(),
  errorMessage: z.string().max(4000).nullable().optional(),
  requestedProvider: z.string().nullable().optional(),
  requestedModel: z.string().nullable().optional(),
  actualProvider: z.string().nullable().optional(),
  actualModel: z.string().nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
});

export const listSchedulesSchema = z.object({
  projectId: z.string().uuid().optional(),
  status: scheduleStatusSchema.optional(),
  targetScope: scheduleTargetScopeSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const acquireDueSchedulesSchema = z.object({
  projectId: z.string().uuid().optional(),
  now: z.coerce.date().optional(),
  limit: z.number().int().positive().max(100).default(20),
});

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ScheduleTargetScope = z.infer<typeof scheduleTargetScopeSchema>;
export type ScheduleRecurrenceSyntax = z.infer<typeof scheduleRecurrenceSyntaxSchema>;
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>;
export type ScheduleCatchUpPolicy = z.infer<typeof scheduleCatchUpPolicySchema>;
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type CreateScheduleRunInput = z.infer<typeof createScheduleRunSchema>;
export type UpdateScheduleRunInput = z.infer<typeof updateScheduleRunSchema>;
export type ListSchedulesInput = z.infer<typeof listSchedulesSchema>;
export type AcquireDueSchedulesInput = z.infer<typeof acquireDueSchedulesSchema>;
