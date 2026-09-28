import { z } from "zod";

export const daemonPhaseSchema = z.enum([
  "planning",
  "execution",
  "review",
  "merge",
  "terminal",
]);

export const daemonQueueOwnerSchema = z.enum([
  "operator",
  "executor",
  "reviewer",
  "merger",
  "none",
]);

export const daemonOutcomeCategorySchema = z.enum([
  "code_finding",
  "conflict",
  "infrastructure",
  "policy",
  "cancellation",
  "unknown",
]);

export const daemonRetryPolicySchema = z.enum([
  "automatic",
  "after_follow_up",
  "manual",
  "none",
]);

export const daemonFollowUpPolicySchema = z.enum([
  "required",
  "forbidden",
  "optional",
]);

export const daemonOutcomeCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

export const daemonOutcomeSchema = z.object({
  code: daemonOutcomeCodeSchema,
  category: daemonOutcomeCategorySchema,
  retryable: z.boolean(),
  retryPolicy: daemonRetryPolicySchema,
  targetPhase: daemonPhaseSchema,
  nextActor: daemonQueueOwnerSchema,
  followUpTask: daemonFollowUpPolicySchema,
  operatorMessage: z.string().min(1).max(1000),
  auditMetadata: z.record(z.unknown()),
});

export type DaemonPhase = z.infer<typeof daemonPhaseSchema>;
export type DaemonQueueOwner = z.infer<typeof daemonQueueOwnerSchema>;
export type DaemonOutcomeCategory = z.infer<typeof daemonOutcomeCategorySchema>;
export type DaemonRetryPolicy = z.infer<typeof daemonRetryPolicySchema>;
export type DaemonFollowUpPolicy = z.infer<typeof daemonFollowUpPolicySchema>;
export type DaemonOutcome = z.infer<typeof daemonOutcomeSchema>;
