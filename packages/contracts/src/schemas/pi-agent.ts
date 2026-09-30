import { z } from "zod";

export const TI_SERVER_AGENT_ID = "task-weaver:ti-agent";
export const PI_SERVER_AGENT_ID = TI_SERVER_AGENT_ID;

export const piCredentialStatusSchema = z.enum(["unknown", "valid", "invalid", "missing"]);
export const piAgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "in_review",
  "cancelled",
]);
export const piAgentExecutionModeSchema = z.enum(["disabled", "dry_run", "live"]);

const ownerSchema = {
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
};

export const upsertPiModelConfigSchema = z.object({
  ...ownerSchema,
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().max(500).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  apiKeyRef: z.string().max(500).nullable().optional(),
  credentialStatus: piCredentialStatusSchema.default("unknown"),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
  costMetadata: z.record(z.unknown()).nullable().optional(),
  availabilityCheckedAt: z.coerce.date().nullable().optional(),
});

export const listPiModelConfigsSchema = z.object({
  ...ownerSchema,
  includeDisabled: z.coerce.boolean().default(false),
});

export const setDefaultPiModelSchema = z.object({
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
  configId: z.string().uuid(),
});

export const upsertPiAgentPolicySchema = z.object({
  ownerId: z.string().optional(),
  ownerType: z.enum(["human", "agent"]).optional(),
  enabled: z.boolean().default(false),
  executionMode: piAgentExecutionModeSchema.default("disabled"),
  maxConcurrentRuns: z.number().int().min(1).max(100).default(1),
  dailyRunLimit: z.number().int().min(0).max(100000).default(25),
  monthlyRunLimit: z.number().int().min(0).max(1_000_000).default(500),
  runTimeoutSeconds: z.number().int().min(30).max(86_400).default(600),
  defaultMaxRetries: z.number().int().min(0).max(20).default(0),
  toolAllowlist: z.array(z.string().min(1).max(200)).optional(),
  toolDenylist: z.array(z.string().min(1).max(200)).optional(),
  assistantAutoEnabled: z.boolean().default(false),
  assistantAutoMode: piAgentExecutionModeSchema.default("disabled"),
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

export const resolvePiModelSchema = z.object({
  ...ownerSchema,
  requestedPiProvider: z.string().min(1).max(120).nullable().optional(),
  requestedPiModel: z.string().min(1).max(200).nullable().optional(),
});

export const createPiAgentRunSchema = z.object({
  taskId: z.string().uuid().optional(),
  scheduleRunId: z.string().uuid().optional(),
  assignedAgentId: z.string().min(1).default(TI_SERVER_AGENT_ID),
  assignedAgentType: z.enum(["human", "agent"]).default("agent"),
  requestedPiProvider: z.string().nullable().optional(),
  requestedPiModel: z.string().nullable().optional(),
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

export const listPiAgentRunsSchema = z.object({
  taskId: z.string().uuid().optional(),
  scheduleRunId: z.string().uuid().optional(),
  assignedAgentId: z.string().optional(),
  status: piAgentRunStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const acquirePiAgentRunSchema = z.object({
  assignedAgentId: z.string().min(1).default(TI_SERVER_AGENT_ID),
  workerId: z.string().min(1),
  durationMinutes: z.number().int().min(1).max(1440).default(15),
});

export const completePiAgentRunSchema = z.object({
  status: z.enum(["succeeded", "failed", "in_review", "cancelled"]),
  actualPiProvider: z.string().nullable().optional(),
  actualPiModel: z.string().nullable().optional(),
  piSessionId: z.string().nullable().optional(),
  eventLog: z.array(z.unknown()).nullable().optional(),
  outputSummary: z.string().max(8000).nullable().optional(),
  errorMessage: z.string().max(8000).nullable().optional(),
  costMetadata: z.record(z.unknown()).nullable().optional(),
});

export type PiCredentialStatus = z.infer<typeof piCredentialStatusSchema>;
export type PiAgentRunStatus = z.infer<typeof piAgentRunStatusSchema>;
export type PiAgentExecutionMode = z.infer<typeof piAgentExecutionModeSchema>;
export type UpsertPiModelConfigInput = z.infer<typeof upsertPiModelConfigSchema>;
export type ListPiModelConfigsInput = z.infer<typeof listPiModelConfigsSchema>;
export type SetDefaultPiModelInput = z.infer<typeof setDefaultPiModelSchema>;
export type ResolvePiModelInput = z.infer<typeof resolvePiModelSchema>;
export type UpsertPiAgentPolicyInput = z.infer<typeof upsertPiAgentPolicySchema>;
export type CreatePiAgentRunInput = z.infer<typeof createPiAgentRunSchema>;
export type ListPiAgentRunsInput = z.infer<typeof listPiAgentRunsSchema>;
export type AcquirePiAgentRunInput = z.infer<typeof acquirePiAgentRunSchema>;
export type CompletePiAgentRunInput = z.infer<typeof completePiAgentRunSchema>;
