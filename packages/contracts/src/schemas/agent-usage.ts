import { z } from "zod";

const counter = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:/@+-]+$/);
export const agentUsageSummarySchema = z
  .object({
    inputTokens: counter.default(null),
    outputTokens: counter.default(null),
    cacheReadTokens: counter.default(null),
    cacheWriteTokens: counter.default(null),
    cacheSemantics: z
      .enum(["included", "additional", "unknown"])
      .default("unknown"),
    provider: identity.default("unknown"),
    model: identity.default("unknown"),
    completeness: z.enum(["complete", "partial", "unknown"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const reported = [
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
    ].some((n) => n !== null);
    if ((value.completeness === "unknown") === reported) {
      ctx.addIssue({
        code: "custom",
        message:
          "Unknown coverage requires absent counters; reported counters require partial or complete coverage",
      });
    }
    if (
      value.completeness === "complete" &&
      (value.inputTokens === null || value.outputTokens === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Complete coverage requires input and output counters",
      });
    }
    if (
      value.cacheSemantics === "included" &&
      value.inputTokens !== null &&
      value.cacheReadTokens !== null &&
      value.cacheReadTokens > value.inputTokens
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Included cache reads cannot exceed input tokens",
      });
    }
  });
export type AgentUsageSummary = z.infer<typeof agentUsageSummarySchema>;
export const usagePhaseSchema = z.enum(["execution", "review", "rework", "integration"]);
export const usageOutcomeSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const snapshotFields = {
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  summary: agentUsageSummarySchema,
  outcome: usageOutcomeSchema,
  endedAt: z.string().datetime().nullable().default(null),
};
export const reportAgentUsageSchema = z
  .object({
    processId: z.string().uuid(),
    daemonId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    leaseGeneration: z.number().int().positive().optional(),
    workerIndex: z.union([z.string().min(1).max(160), z.number().int().nonnegative()]).optional(),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
    agent: identity,
    phase: usagePhaseSchema,
    startedAt: z.string().datetime(),
    ...snapshotFields,
  })
  .strict()
  .superRefine(validateTimes);
export const reportTiAgentUsageSchema = z
  .object({
    processId: z.string().uuid(),
    workerId: z.string().min(1).max(160),
    leaseGeneration: z.number().int().positive().optional(),
    attempt: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    ...snapshotFields,
  })
  .strict()
  .superRefine(validateTimes);
function validateTimes(
  value: { startedAt: string; endedAt: string | null; outcome: string },
  ctx: z.RefinementCtx,
) {
  if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt))
    ctx.addIssue({ code: "custom", message: "Run end precedes start" });
  if ((value.outcome === "running") !== (value.endedAt === null))
    ctx.addIssue({
      code: "custom",
      message: "Only running processes can omit the end timestamp",
    });
}
export const agentUsageQuerySchema = z
  .object({
    scope: z.enum(["project", "personal"]).default("project"),
    projectId: z.string().uuid().optional(),
    source: z.enum(["codex_jsonl", "daemon_unknown", "ti_runtime", "ti_chat", "ti_operation"]).optional(),
    model: z.string().max(160).optional(),
    conversationId: z.string().uuid().optional(),
    groupBy: z.enum(["source", "model"]).optional(),
    requirementId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    phase: usagePhaseSchema.optional(),
    completeness: z.enum(["complete", "partial", "unknown"]).optional(),
    limit: z.coerce.number<number>().int().min(1).max(100).default(25),
    offset: z.coerce.number<number>().int().nonnegative().default(0),
  })
  .strict()
  .refine(v => v.scope === "project" ? !!v.projectId : !v.projectId && !v.requirementId && !v.taskId,
    "Choose a project or an unassociated personal scope")
  .refine(
    (v) => !v.since || !v.until || Date.parse(v.since) <= Date.parse(v.until),
    "Invalid time range",
  );
export const reportPiAgentUsageSchema = reportTiAgentUsageSchema;
export type ReportAgentUsageInput = z.infer<typeof reportAgentUsageSchema>;
export type ReportTiAgentUsageInput = z.infer<typeof reportTiAgentUsageSchema>;
export type ReportPiAgentUsageInput = ReportTiAgentUsageInput;
export type AgentUsageQuery = z.infer<typeof agentUsageQuerySchema>;

/** Deliberately excludes endpoints, proxy settings, credentials and arbitrary metadata. */
export const usageModelSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  configurationId: z.string().uuid(),
  configurationUpdatedAt: z.string().datetime(),
  displayName: z.string().max(500).nullable(),
  provider: z.string().max(160),
  configuredModel: z.string().max(160),
  generation: z.object({ temperature: z.number().finite().optional(), maxTokens: z.number().int().positive().optional() }).strict(),
}).strict();
export type UsageModelSnapshot = z.infer<typeof usageModelSnapshotSchema>;
