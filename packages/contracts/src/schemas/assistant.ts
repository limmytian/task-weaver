import { z } from "zod";
import { docTypeSchema } from "./documents";
import { TI_SERVER_AGENT_ID } from "./ti-agent";
import {
  scheduleCatchUpPolicySchema,
  scheduleKindSchema,
  scheduleRecurrenceSyntaxSchema,
  scheduleTargetScopeSchema,
} from "./schedules";
import { taskPrioritySchema, taskStatusSchema } from "./tasks";

export const assistantContextKindSchema = z.enum([
  "global",
  "project",
  "requirement",
  "task",
  "schedule",
]);

export const assistantMessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const assistantActionTypeSchema = z.enum([
  "create_task",
  "update_task",
  "create_schedule",
  "pause_schedule",
  "queue_ti_run",
  "add_comment",
  "add_note",
  "draft_document",
  "platform_operation",
]);
export const assistantActionStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
]);

export const assistantWorkflowSchema = z.enum([
  "project_health",
  "stale_tasks",
  "failed_ti_runs",
  "schedule_maintenance",
  "requirement_next_steps",
  "personal_inbox_cleanup",
]);

export const assistantContextLimitsSchema = z.object({
  recentActivity: z.coerce.number().int().min(0).max(50).default(10),
  recentMessages: z.coerce.number().int().min(0).max(50).default(12),
  requirements: z.coerce.number().int().min(0).max(50).default(12),
  tasks: z.coerce.number().int().min(0).max(100).default(25),
  schedules: z.coerce.number().int().min(0).max(50).default(10),
  documents: z.coerce.number().int().min(0).max(50).default(8),
  memories: z.coerce.number().int().min(0).max(50).default(8),
  mcpTools: z.coerce.number().int().min(0).max(50).default(12),
  tiRuns: z.coerce.number().int().min(0).max(50).default(8),
  textChars: z.coerce.number().int().min(200).max(8000).default(1200),
}).default({});

export const buildAssistantContextSchema = z.object({
  contextKind: assistantContextKindSchema.default("global"),
  projectId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  scheduleId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  intent: z.string().max(1000).optional(),
  includeGlobal: z.coerce.boolean().default(true),
  includePersonal: z.coerce.boolean().default(true),
  limits: assistantContextLimitsSchema,
});

export const createAssistantConversationSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  requirementId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  scheduleId: z.string().uuid().nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  contextKind: assistantContextKindSchema.default("global"),
});

export const listAssistantConversationsSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  requirementId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  scheduleId: z.string().uuid().nullable().optional(),
  contextKind: assistantContextKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

export const renameAssistantConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(500),
});

export const createAssistantMessageSchema = z.object({
  conversationId: z.string().uuid(),
  role: assistantMessageRoleSchema,
  content: z.string().min(1).max(100_000),
  contextSnapshot: z.record(z.unknown()).nullable().optional(),
  tiAgentRunId: z.string().uuid().nullable().optional(),
  provider: z.string().max(120).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const createAssistantActionSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().nullable().optional(),
  actionType: assistantActionTypeSchema,
  targetType: z.enum(["project", "requirement", "task", "schedule", "document", "ti_agent_run"]).nullable().optional(),
  targetId: z.string().uuid().nullable().optional(),
  payload: z.record(z.unknown()),
  preview: z.string().max(8000).nullable().optional(),
});

export const updateAssistantActionStatusSchema = z.object({
  status: assistantActionStatusSchema,
  executionResult: z.record(z.unknown()).nullable().optional(),
  activityLogId: z.string().uuid().nullable().optional(),
  errorMessage: z.string().max(8000).nullable().optional(),
});

const createTaskActionPayloadSchema = z.object({
  projectId: z.string().uuid(),
  requirementId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(8000).optional(),
  priority: taskPrioritySchema.default("medium"),
  assignee: z.string().optional(),
  assigneeType: z.enum(["human", "agent"]).optional(),
  tags: z.array(z.string()).optional(),
});

const updateTaskActionPayloadSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  reason: z.string().max(1000).optional(),
  force: z.boolean().default(false),
})
  .refine(
    (data) => Object.keys(data).some((key) => !["taskId", "reason", "force"].includes(key)),
    "Update task actions require at least one task field or status",
  );

const createScheduleActionPayloadSchema = z.object({
  projectId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
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
  taskTemplate: z.object({
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    priority: taskPrioritySchema.default("medium"),
  }),
  autoRun: z.boolean().default(false),
  assignedExecutor: z.string().optional(),
  assignedExecutorType: z.enum(["human", "agent"]).optional(),
  requestedProvider: z.string().optional(),
  requestedModel: z.string().optional(),
}).superRefine((value, ctx) => {
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
});

const pauseScheduleActionPayloadSchema = z.object({
  scheduleId: z.string().uuid(),
});

const queueTiRunActionPayloadSchema = z.object({
  taskId: z.string().uuid().optional(),
  scheduleRunId: z.string().uuid().optional(),
  assignedAgentId: z.string().min(1).default(TI_SERVER_AGENT_ID),
  assignedAgentType: z.enum(["human", "agent"]).default("agent"),
  requestedProvider: z.string().nullable().optional(),
  requestedModel: z.string().nullable().optional(),
  workspacePolicy: z.enum(["ephemeral", "persistent_purged_on_finish"]).default("ephemeral"),
  maxRetries: z.number().int().min(0).max(20).optional(),
}).superRefine((data, ctx) => {
  if (!data.taskId && !data.scheduleRunId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taskId"],
      message: "A Ti agent run requires taskId or scheduleRunId",
    });
  }
});

const taskTextActionPayloadSchema = z.object({
  taskId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
});

const addNoteActionPayloadSchema = taskTextActionPayloadSchema.extend({
  pinned: z.boolean().default(false),
});

const draftDocumentActionPayloadSchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  summary: z.string().max(1000).optional(),
  keywords: z.array(z.string()).optional(),
  docType: docTypeSchema.optional(),
  language: z.string().max(10).optional(),
  generatedBy: z.string().optional(),
  generationPrompt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().default(true),
});

export const assistantActionProposalSchema = z.discriminatedUnion("actionType", [
  z.object({ actionType: z.literal("platform_operation"), payload: z.object({ operation: z.string().min(1).max(100), input: z.record(z.unknown()) }).strict(), preview: z.string().optional() }),
  z.object({
    actionType: z.literal("create_task"),
    payload: createTaskActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("update_task"),
    payload: updateTaskActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("create_schedule"),
    payload: createScheduleActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("pause_schedule"),
    payload: pauseScheduleActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("queue_ti_run"),
    payload: queueTiRunActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("add_comment"),
    payload: taskTextActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("add_note"),
    payload: addNoteActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
  z.object({
    actionType: z.literal("draft_document"),
    payload: draftDocumentActionPayloadSchema,
    preview: z.string().max(8000).optional(),
  }),
]);

export const sendAssistantMessageSchema = z.object({
  requestId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  context: buildAssistantContextSchema,
  message: z.string().min(1).max(20_000),
  requestedProvider: z.string().min(1).max(120).nullable().optional(),
  requestedModel: z.string().min(1).max(200).nullable().optional(),
  workflow: assistantWorkflowSchema.optional(),
  proposedActions: z.array(assistantActionProposalSchema).max(8).default([]),
});

export const executeAssistantActionSchema = z.object({
  id: z.string().uuid(),
});

export type AssistantContextKind = z.infer<typeof assistantContextKindSchema>;
export type AssistantMessageRole = z.infer<typeof assistantMessageRoleSchema>;
export type AssistantActionType = z.infer<typeof assistantActionTypeSchema>;
export type AssistantActionStatus = z.infer<typeof assistantActionStatusSchema>;
export type AssistantWorkflow = z.infer<typeof assistantWorkflowSchema>;
export type AssistantContextLimits = z.infer<typeof assistantContextLimitsSchema>;
export type BuildAssistantContextInput = z.infer<typeof buildAssistantContextSchema>;
export type CreateAssistantConversationInput = z.infer<typeof createAssistantConversationSchema>;
export type ListAssistantConversationsInput = z.infer<typeof listAssistantConversationsSchema>;
export type RenameAssistantConversationInput = z.infer<typeof renameAssistantConversationSchema>;
export type CreateAssistantMessageInput = z.infer<typeof createAssistantMessageSchema>;
export type CreateAssistantActionInput = z.infer<typeof createAssistantActionSchema>;
export type UpdateAssistantActionStatusInput = z.infer<typeof updateAssistantActionStatusSchema>;
export type AssistantActionProposal = z.infer<typeof assistantActionProposalSchema>;
export type SendAssistantMessageInput = z.infer<typeof sendAssistantMessageSchema>;
export type ExecuteAssistantActionInput = z.infer<typeof executeAssistantActionSchema>;

export const assistantPolicySchema = z.object({
  assistantAutoEnabled: z.boolean(),
  assistantAutoMode: z.enum(["disabled", "dry_run", "confirm", "live"]),
  assistantActionAllowlist: z.array(assistantActionTypeSchema).max(8),
  assistantDailyActionLimit: z.number().int().min(0).max(100_000),
  assistantRunTimeoutSeconds: z.number().int().min(30).max(86_400),
  assistantDefaultMaxRetries: z.number().int().min(0).max(20),
  assistantUncertainToReview: z.boolean(),
}).strict();
export const updateAssistantPolicySchema = assistantPolicySchema.partial().strict();
export type AssistantPolicy = z.infer<typeof assistantPolicySchema>;

export const chatProxyModeSchema = z.enum(["inherit", "direct", "custom"]);
export const chatProxyUrlSchema = z.string().trim().url().max(500).refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}, "Use an HTTP or HTTPS proxy URL without credentials, path, query or fragment");
export type ChatProxySettings = { proxyMode?: z.infer<typeof chatProxyModeSchema>; proxyUrl?: string | null };

export const saveChatModelSchema = z.object({
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(500).optional(),
  label: z.string().max(200).nullable().optional(),
  proxyMode: chatProxyModeSchema.optional(),
  proxyUrl: chatProxyUrlSchema.nullable().optional(),
  apiKey: z.string().trim().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/, "API keys cannot contain whitespace or control characters").optional(),
  credentialStatus: z.enum(["unknown", "valid", "invalid", "missing"]).optional(),
  enabled: z.boolean().optional(),
  isDefaultChat: z.boolean().optional(),
  isDefaultAgent: z.boolean().optional(),
}).strict().refine(input => input.proxyMode !== "custom" || !!input.proxyUrl,
  { message: "A custom proxy requires a proxy URL", path: ["proxyUrl"] });
export const chatModelIdSchema = z.object({ id: z.string().uuid() }).strict();

export const getAssistantMessageResultSchema = z.object({ requestId: z.string().uuid() }).strict();

/** Wire events contain display text and status, never tool arguments or credentials. */
export const assistantStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), conversationId: z.string().uuid(), userMessageId: z.string().uuid() }),
  z.object({ type: z.literal("turn"), turn: z.number().int().min(0) }),
  z.object({ type: z.literal("text"), delta: z.string().max(32_000) }),
  z.object({ type: z.literal("tool"), name: z.string().max(100), status: z.enum(["reading", "executing", "proposed", "completed", "failed"]) }),
  z.object({ type: z.literal("completed"), result: z.unknown() }),
  z.object({ type: z.literal("failed"), message: z.string(), code: z.string(), httpStatus: z.number().int() }),
]);
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;
export const streamAssistantMessageSchema = sendAssistantMessageSchema.extend({ requestId: z.string().uuid() });
