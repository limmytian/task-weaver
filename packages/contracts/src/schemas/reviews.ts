import { z } from "zod";
import { requirementLeaseFenceFields } from "./common";

export const reviewMergeModeSchema = z.enum(["provider", "direct", "manual"]);
export const reviewRunStatusSchema = z.enum([
  "running",
  "approved",
  "changes_requested",
  "blocked",
  "failed",
  "superseded",
]);
export const reviewCheckStatusSchema = z.enum(["queued", "running", "passed", "failed", "skipped"]);
export const reviewFindingSeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export const reviewFindingStatusSchema = z.enum(["open", "resolved", "dismissed"]);
export const reviewDecisionKindSchema = z.enum(["ai", "human", "forge", "override"]);
export const reviewDecisionValueSchema = z.enum([
  "approved",
  "changes_requested",
  "abstained",
  "bypassed",
]);

export const reviewRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(0).max(20).default(3),
  initialBackoffSeconds: z.number().int().min(1).max(86_400).default(30),
  maxBackoffSeconds: z.number().int().min(1).max(604_800).default(900),
}).superRefine((value, ctx) => {
  if (value.maxBackoffSeconds < value.initialBackoffSeconds) {
    ctx.addIssue({
      code: "custom",
      path: ["maxBackoffSeconds"],
      message: "Maximum backoff must be greater than or equal to initial backoff",
    });
  }
});

export const reviewPolicyInputSchema = z.object({
  requiredChecks: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  requireAiReview: z.boolean().default(false),
  minimumHumanApprovals: z.number().int().min(0).max(20).default(0),
  requireIndependentReviewer: z.boolean().default(false),
  requireIndependentMerger: z.boolean().default(false),
  allowedMergeModes: z.array(reviewMergeModeSchema).min(1).max(3)
    .default(["provider", "direct", "manual"]),
  defaultMergeMode: reviewMergeModeSchema.default("direct"),
  baseBranch: z.string().trim().min(1).max(255).default("main"),
  retryPolicy: reviewRetryPolicySchema.default({
    maxAttempts: 3,
    initialBackoffSeconds: 30,
    maxBackoffSeconds: 900,
  }),
  allowManualOverride: z.boolean().default(false),
  overrideRequiresReason: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (new Set(value.requiredChecks).size !== value.requiredChecks.length) {
    ctx.addIssue({ code: "custom", path: ["requiredChecks"], message: "Required check names must be unique" });
  }
  if (new Set(value.allowedMergeModes).size !== value.allowedMergeModes.length) {
    ctx.addIssue({ code: "custom", path: ["allowedMergeModes"], message: "Merge modes must be unique" });
  }
  if (!value.allowedMergeModes.includes(value.defaultMergeMode)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultMergeMode"],
      message: "Default merge mode must be included in allowed merge modes",
    });
  }
});

export const createReviewRunSchema = z.object({
  requirementRepositoryId: z.string().uuid(),
  headCommit: z.string().trim().min(7).max(128),
  baseCommit: z.string().trim().min(7).max(128),
  executorActorId: z.string().min(1).max(500).optional(),
  executorActorType: z.enum(["human", "agent"]).optional(),
  executorDaemonId: z.string().uuid().optional(),
  ...requirementLeaseFenceFields,
}).superRefine((value, ctx) => {
  if ((value.executorActorId === undefined) !== (value.executorActorType === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["executorActorId"],
      message: "Executor actor ID and type must be provided together",
    });
  }
});

export const upsertReviewCheckSchema = z.object({
  name: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(100).default("local"),
  status: reviewCheckStatusSchema,
  externalUrl: z.string().url().max(2000).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  ...requirementLeaseFenceFields,
});

export const upsertReviewFindingSchema = z.object({
  fingerprint: z.string().trim().min(1).max(500),
  severity: reviewFindingSeveritySchema,
  title: z.string().trim().min(1).max(500),
  detail: z.string().trim().min(1).max(20_000),
  path: z.string().max(2000).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  status: reviewFindingStatusSchema.default("open"),
  ...requirementLeaseFenceFields,
});

export const recordReviewDecisionSchema = z.object({
  kind: reviewDecisionKindSchema,
  decision: reviewDecisionValueSchema,
  headCommit: z.string().trim().min(7).max(128),
  summary: z.string().max(20_000).nullable().optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  ...requirementLeaseFenceFields,
});

export const evaluateReviewRunSchema = z.object({
  mergerActorId: z.string().min(1).max(500).optional(),
  mergerActorType: z.enum(["human", "agent"]).optional(),
  mergerDaemonId: z.string().uuid().optional(),
  mergeMode: reviewMergeModeSchema.optional(),
  ...requirementLeaseFenceFields,
}).superRefine((value, ctx) => {
  if ((value.mergerActorId === undefined) !== (value.mergerActorType === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["mergerActorId"],
      message: "Merger actor ID and type must be provided together",
    });
  }
});

export const listReviewRunsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ReviewMergeMode = z.infer<typeof reviewMergeModeSchema>;
export type ReviewRunStatus = z.infer<typeof reviewRunStatusSchema>;
export type ReviewPolicyInput = z.infer<typeof reviewPolicyInputSchema>;
export type ReviewRetryPolicy = z.infer<typeof reviewRetryPolicySchema>;
export type CreateReviewRunInput = z.infer<typeof createReviewRunSchema>;
export type UpsertReviewCheckInput = z.infer<typeof upsertReviewCheckSchema>;
export type UpsertReviewFindingInput = z.infer<typeof upsertReviewFindingSchema>;
export type RecordReviewDecisionInput = z.infer<typeof recordReviewDecisionSchema>;
export type EvaluateReviewRunInput = z.infer<typeof evaluateReviewRunSchema>;
