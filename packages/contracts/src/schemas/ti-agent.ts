import { z } from "zod";

export const TI_SERVER_AGENT_ID = "task-weaver:ti-agent";

export const tiCredentialStatusSchema = z.enum(["unknown", "valid", "invalid", "missing"]);
export const tiAgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "in_review",
  "cancelled",
]);
export const tiAgentExecutionModeSchema = z.enum(["disabled", "dry_run", "live"]);
export const tiAgentWorkspacePolicySchema = z.enum([
  "ephemeral",
  "persistent_purged_on_finish",
]);

const ownerSchema = {
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
};

export const upsertTiModelConfigSchema = z.object({
  ...ownerSchema,
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().max(500).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  apiKeyRef: z.string().max(500).nullable().optional(),
  credentialStatus: tiCredentialStatusSchema.default("unknown"),
  enabled: z.boolean().default(true),
  isDefaultChat: z.boolean().default(false),
  isDefaultAgent: z.boolean().default(false),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
  costMetadata: z.record(z.unknown()).nullable().optional(),
  availabilityCheckedAt: z.coerce.date().nullable().optional(),
});

export const listTiModelConfigsSchema = z.object({
  ...ownerSchema,
  includeDisabled: z.coerce.boolean().default(false),
});

export const setDefaultTiModelSchema = z.object({
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
  configId: z.string().uuid(),
  target: z.enum(["chat", "agent", "both"]).default("agent"),
});

export const upsertTiAgentPolicySchema = z.object({
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
  enabled: z.boolean().default(false),
  executionMode: tiAgentExecutionModeSchema.default("disabled"),
  maxConcurrentRuns: z.number().int().min(1).max(100).default(1),
  dailyRunLimit: z.number().int().min(0).max(100_000).default(25),
  monthlyRunLimit: z.number().int().min(0).max(1_000_000).default(500),
  runTimeoutSeconds: z.number().int().min(30).max(86_400).default(600),
  defaultMaxRetries: z.number().int().min(0).max(20).default(0),
  sandboxTemplate: z.string().max(200).nullable().optional(),
  allowNetwork: z.boolean().default(false),
  allowedTools: z.array(z.string().min(1).max(200)).optional(),
  deniedTools: z.array(z.string().min(1).max(200)).optional(),
  assistantAutoEnabled: z.boolean().default(false),
  assistantAutoMode: tiAgentExecutionModeSchema.default("disabled"),
  assistantActionAllowlist: z.array(z.string().min(1).max(200)).default([]),
  assistantDailyActionLimit: z.number().int().min(0).max(100_000).default(10),
  assistantRunTimeoutSeconds: z.number().int().min(30).max(86_400).default(300),
  assistantDefaultMaxRetries: z.number().int().min(0).max(20).default(0),
  assistantUncertainToReview: z.boolean().default(true),
}).superRefine((data, ctx) => {
  if (data.enabled && data.executionMode === "disabled") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executionMode"],
      message: "Enabled Ti agent policies must use dry_run or live execution mode",
    });
  }
  if (data.assistantAutoEnabled && data.assistantAutoMode === "disabled") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assistantAutoMode"],
      message: "Enabled assistant automatic maintenance must use dry_run or live mode",
    });
  }
});

export const resolveTiModelSchema = z.object({
  ...ownerSchema,
  requestedProvider: z.string().min(1).max(120).nullable().optional(),
  requestedModel: z.string().min(1).max(200).nullable().optional(),
  target: z.enum(["chat", "agent"]).default("agent"),
});

export const createTiAgentRunSchema = z.object({
  taskId: z.string().uuid().optional(),
  scheduleRunId: z.string().uuid().optional(),
  assignedAgentId: z.string().uuid(),
  assignedAgentType: z.enum(["human", "agent"]).default("agent"),
  requestedProvider: z.string().nullable().optional(),
  requestedModel: z.string().nullable().optional(),
  workspacePolicy: tiAgentWorkspacePolicySchema.default("ephemeral"),
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

export const listTiAgentRunsSchema = z.object({
  taskId: z.string().uuid().optional(),
  scheduleRunId: z.string().uuid().optional(),
  assignedAgentId: z.string().optional(),
  status: tiAgentRunStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const acquireTiAgentRunSchema = z.object({
  assignedAgentId: z.string().uuid(),
  workerId: z.string().min(1),
  durationMinutes: z.number().int().min(1).max(15).default(15),
});

export const tiWorkerFenceSchema = z.object({ workerId: z.string().min(1).max(200), leaseGeneration: z.number().int().positive() });
export const tiHeartbeatSchema = tiWorkerFenceSchema.extend({ durationMinutes: z.number().int().min(1).max(15).default(15) }).strict();
export const tiProgressSchema = tiWorkerFenceSchema.extend({ eventLog: z.array(z.unknown()).max(500), outputSummary: z.string().max(8000).nullable().optional(), actualProvider: z.string().nullable().optional(), actualModel: z.string().nullable().optional(), sandboxSessionId: z.string().nullable().optional(), tokenUsageId: z.string().uuid().nullable().optional() }).strict();
export const tiRetrySchema = tiWorkerFenceSchema.extend({ errorMessage: z.string().max(8000), delayMs: z.number().int().min(0).max(300_000) }).strict();

export const completeTiAgentRunSchema = z.object({
  workerId: z.string().min(1).optional(),
  leaseGeneration: z.number().int().positive().optional(),
  status: z.enum(["succeeded", "failed", "in_review", "cancelled"]),
  actualProvider: z.string().nullable().optional(),
  actualModel: z.string().nullable().optional(),
  sandboxSessionId: z.string().nullable().optional(),
  tokenUsageId: z.string().uuid().nullable().optional(),
  eventLog: z.array(z.unknown()).nullable().optional(),
  outputSummary: z.string().max(8000).nullable().optional(),
  errorMessage: z.string().max(8000).nullable().optional(),
  costMetadata: z.record(z.unknown()).nullable().optional(),
});

export type TiCredentialStatus = z.infer<typeof tiCredentialStatusSchema>;
export type TiAgentRunStatus = z.infer<typeof tiAgentRunStatusSchema>;
export type TiAgentExecutionMode = z.infer<typeof tiAgentExecutionModeSchema>;
export type TiAgentWorkspacePolicy = z.infer<typeof tiAgentWorkspacePolicySchema>;
export type UpsertTiModelConfigInput = z.input<typeof upsertTiModelConfigSchema>;
export type ListTiModelConfigsInput = z.input<typeof listTiModelConfigsSchema>;
export type SetDefaultTiModelInput = z.input<typeof setDefaultTiModelSchema>;
export type ResolveTiModelInput = z.input<typeof resolveTiModelSchema>;
export type UpsertTiAgentPolicyInput = z.input<typeof upsertTiAgentPolicySchema>;
export type CreateTiAgentRunInput = z.input<typeof createTiAgentRunSchema>;
export type ListTiAgentRunsInput = z.input<typeof listTiAgentRunsSchema>;
export type AcquireTiAgentRunInput = z.input<typeof acquireTiAgentRunSchema>;
export type CompleteTiAgentRunInput = z.input<typeof completeTiAgentRunSchema>;
