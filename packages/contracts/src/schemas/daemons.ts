import { z } from "zod";

export const daemonRoleSchema = z.enum(["executor", "reviewer", "merger"]);
export const daemonControlStateSchema = z.enum(["running", "paused", "draining", "drained"]);
export const daemonControlActionSchema = z.enum(["pause", "drain", "resume"]);

export const daemonProgressPhaseSchema = z.enum([
  "claiming",
  "executing",
  "task_completed",
  "awaiting_review",
  "reviewing",
  "merging",
  "finalizing",
  "recovering",
  "quarantined",
  "completed",
  "failed",
  "cancelled",
]);

export const daemonProgressSourceSchema = z.enum([
  "daemon",
  "task_status",
  "recovery",
  "system",
]);

export const daemonWorkspaceStateSchema = z.enum([
  "unknown",
  "clean",
  "dirty",
  "conflicted",
  "missing",
]);

export const daemonRecoveryDispositionSchema = z.enum([
  "none",
  "resume",
  "retry",
  "review",
  "quarantine",
  "manual",
]);

export const daemonWorkerStateSchema = z.object({
  index: z.number().int().min(0),
  status: z.enum(["idle", "claiming", "running", "stopping", "failed"]),
  requirementId: z.string().uuid().nullable().optional(),
  requirementTitle: z.string().nullable().optional(),
  executionSliceId: z.string().uuid().nullable().optional(),
  executionSliceTitle: z.string().nullable().optional(),
  modelTier: z.enum(["fast", "standard", "strong"]).nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  taskTitle: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  leaseGeneration: z.number().int().positive().nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  progressPhase: daemonProgressPhaseSchema.nullable().optional(),
  progressVersion: z.number().int().positive().nullable().optional(),
  leaseHealthy: z.boolean().nullable().optional(),
  leaseHeartbeatFailures: z.number().int().min(0).nullable().optional(),
  lastLeaseError: z.string().nullable().optional(),
});

export const registerDaemonSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  role: daemonRoleSchema.default("executor"),
  capabilities: z.array(z.string()),
  host: z.string().min(1).max(255).optional(),
  processStartedAt: z.string().datetime({ offset: true }).optional(),
  workerCapacity: z.number().int().min(1).max(256).default(1),
}).superRefine((value, ctx) => {
  if (value.role === "executor") {
    const hasExecutor = value.capabilities.some((capability) =>
      capability.startsWith("executor:")
      || (!capability.includes(":") && capability !== "review" && capability !== "merge"),
    );
    if (!hasExecutor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "executor daemons must advertise at least one runnable AI executor",
      });
    }
  }
  const requiredCapability = value.role === "reviewer"
    ? "review"
    : value.role === "merger"
      ? "merge"
      : null;
  if (requiredCapability && !value.capabilities.includes(requiredCapability)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capabilities"],
      message: `${value.role} daemons must advertise the '${requiredCapability}' capability`,
    });
  }
});

export const updateDaemonStatusSchema = z.object({
  status: z.enum(["idle", "busy", "offline"]),
  activeTaskIds: z.array(z.string().uuid()).optional(),
  activeWorkerStates: z.array(daemonWorkerStateSchema).optional(),
});

export const requestDaemonControlSchema = z.object({
  action: daemonControlActionSchema,
  reason: z.string().trim().min(3).max(1000),
});

export const reportDaemonProgressSchema = z.object({
  eventId: z.string().uuid().optional(),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative().optional(),
  workerIndex: z.number().int().min(0),
  requirementId: z.string().uuid(),
  executionSliceId: z.string().uuid().nullable().optional(),
  currentTaskId: z.string().uuid().nullable().optional(),
  phase: daemonProgressPhaseSchema,
  message: z.string().max(2000).nullable().optional(),
  workspaceState: daemonWorkspaceStateSchema.optional(),
  recoveryDisposition: daemonRecoveryDispositionSchema.optional(),
  lastCompletedTaskId: z.string().uuid().nullable().optional(),
  pendingDiffSummary: z.string().max(10_000).nullable().optional(),
  sliceSummary: z.string().max(10_000).nullable().optional(),
  handoffSummary: z.string().max(10_000).nullable().optional(),
  source: daemonProgressSourceSchema.default("daemon"),
  severity: z.enum(["debug", "info", "warn", "error"]).optional(),
  leaseGeneration: z.number().int().positive(),
  details: z.record(z.unknown()).default({}),
});

export const reconcileDaemonWorkerSchema = z.object({
  runId: z.string().uuid(),
  workerIndex: z.number().int().min(0),
  requirementId: z.string().uuid(),
  executionSliceId: z.string().uuid().nullable().optional(),
  leaseGeneration: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
  workspaceState: daemonWorkspaceStateSchema.default("unknown"),
  pendingDiffSummary: z.string().max(10_000).nullable().optional(),
  sliceSummary: z.string().max(10_000).nullable().optional(),
  handoffSummary: z.string().max(10_000).nullable().optional(),
});

export const daemonProgressQuerySchema = z.object({
  daemonId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  workerIndex: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const daemonTimelineQuerySchema = z.object({
  requirementId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const daemonHistoryKindSchema = z.enum([
  "progress",
  "task",
  "delivery",
  "review",
  "merge",
  "retry",
  "control",
]);

export const daemonHistoryQuerySchema = z.object({
  daemonId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  workerIndex: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).max(512).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  severity: z.enum(["debug", "info", "warn", "error"]).optional(),
  kind: daemonHistoryKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const daemonSloQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

export const daemonMetricsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  windowHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  bucketMinutes: z.coerce.number().int().min(1).max(360).default(60),
});

export const applyTaskSchema = z.object({
  projectId: z.string().uuid().optional(),
});

export const applyRequirementSchema = z.object({
  projectId: z.string().uuid().optional(),
  workerIndex: z.number().int().min(0).optional(),
  modelTiers: z.array(z.enum(["fast", "standard", "strong"])).optional(),
  includeDiagnostics: z.boolean().default(true),
});

export const schedulerEligibilityReasonSchema = z.enum([
  "status",
  "dependency",
  "claim",
  "slice_order",
  "capability",
  "model_tier",
  "retry_time",
  "policy",
]);

export const schedulerEligibilityDiagnosticsSchema = z.object({
  candidateCount: z.number().int().min(0),
  examinedCount: z.number().int().min(0),
  runnableCount: z.number().int().min(0),
  selectedCount: z.number().int().min(0).max(1),
  truncated: z.boolean(),
  skipCounts: z.record(schedulerEligibilityReasonSchema, z.number().int().min(0)),
  samples: z.array(z.object({
    requirementId: z.string(),
    taskId: z.string(),
    reasons: z.array(schedulerEligibilityReasonSchema),
  })),
});

export const applyReviewSchema = z.object({
  projectId: z.string().uuid().optional(),
  workerIndex: z.number().int().min(0).optional(),
});

export const applyMergeSchema = z.object({
  projectId: z.string().uuid().optional(),
  workerIndex: z.number().int().min(0).optional(),
});

export const daemonConfigSchema = z.object({
  executionDelegationSupported: z.boolean().optional(),
  mode: z.enum(["polling", "sse"]),
  pollingIntervalMs: z.number(),
  pollingBackoffMax: z.number(),
  sseEndpoint: z.string().optional(),
});

export type RegisterDaemonInput = z.infer<typeof registerDaemonSchema>;
export type DaemonRole = z.infer<typeof daemonRoleSchema>;
export type DaemonControlState = z.infer<typeof daemonControlStateSchema>;
export type DaemonControlAction = z.infer<typeof daemonControlActionSchema>;
export type UpdateDaemonStatusInput = z.infer<typeof updateDaemonStatusSchema>;
export type ApplyTaskInput = z.infer<typeof applyTaskSchema>;
export type ApplyRequirementInput = z.infer<typeof applyRequirementSchema>;
export type SchedulerEligibilityReason = z.infer<typeof schedulerEligibilityReasonSchema>;
export type SchedulerEligibilityDiagnostics = z.infer<typeof schedulerEligibilityDiagnosticsSchema>;
export type ApplyReviewInput = z.infer<typeof applyReviewSchema>;
export type ApplyMergeInput = z.infer<typeof applyMergeSchema>;
export type DaemonWorkerState = z.infer<typeof daemonWorkerStateSchema>;
export type DaemonProgressPhase = z.infer<typeof daemonProgressPhaseSchema>;
export type DaemonProgressSource = z.infer<typeof daemonProgressSourceSchema>;
export type DaemonWorkspaceState = z.infer<typeof daemonWorkspaceStateSchema>;
export type DaemonRecoveryDisposition = z.infer<typeof daemonRecoveryDispositionSchema>;
export type ReportDaemonProgressInput = z.infer<typeof reportDaemonProgressSchema>;
export type ReconcileDaemonWorkerInput = z.infer<typeof reconcileDaemonWorkerSchema>;
export type DaemonProgressQuery = z.infer<typeof daemonProgressQuerySchema>;
export type DaemonTimelineQuery = z.infer<typeof daemonTimelineQuerySchema>;
export type DaemonHistoryKind = z.infer<typeof daemonHistoryKindSchema>;
export type DaemonHistoryQuery = z.infer<typeof daemonHistoryQuerySchema>;
export type DaemonSloQuery = z.infer<typeof daemonSloQuerySchema>;
export type DaemonMetricsQuery = z.infer<typeof daemonMetricsQuerySchema>;
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

/** Subject, phase, grants and repositories are resolved by the authenticated supervisor service. */
export const issueExecutionDelegationSchema = z.object({
  requirementId: z.string().uuid(),
  runId: z.string().uuid(),
  workerIndex: z.number().int().min(0).max(255),
  leaseGeneration: z.number().int().positive().safe(),
  taskId: z.string().uuid().optional(),
}).strict();
export type IssueExecutionDelegationInput = z.infer<typeof issueExecutionDelegationSchema>;
