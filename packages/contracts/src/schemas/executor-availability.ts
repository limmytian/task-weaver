import { z } from "zod";

export const executorToolSchema = z.enum(["codex", "claude", "agy", "aider", "cursor"]);
export const executorFailureSchema = z.enum(["rate_limited", "quota_exhausted", "billing_blocked", "auth_required", "unknown_failure"]);
export const executorAvailabilityStateSchema = z.enum(["unknown", "available", "cooling_down", "action_required"]);
export const executorQuotaWindowSchema = z.object({
  bucket: z.string().min(1).max(100),
  window: z.enum(["primary", "secondary"]),
  usedPercent: z.number().min(0).max(100).nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  durationMinutes: z.number().int().positive().nullable(),
  resetAt: z.string().datetime().nullable(),
});
export const executorObservationSchema = z.object({
  eventId: z.string().uuid(),
  tool: executorToolSchema,
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  poolId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).nullable().default(null),
  toolVersion: z.string().max(100).nullable(),
  authenticationMode: z.enum(["subscription", "api_key", "unknown"]).default("unknown"),
  state: executorAvailabilityStateSchema,
  failure: executorFailureSchema.nullable(),
  source: z.enum(["status_query", "structured_error", "text_error", "unsupported", "execution_success", "manual_resume"]),
  confidence: z.enum(["high", "low", "unknown"]),
  observedAt: z.string().datetime(),
  staleAt: z.string().datetime(),
  resetAt: z.string().datetime().nullable(),
  retryAfterSeconds: z.number().min(0).max(604800).nullable(),
  reason: z.string().max(500),
  windows: z.array(executorQuotaWindowSchema).max(64),
});
export type ExecutorObservation = z.infer<typeof executorObservationSchema>;
export type ExecutorTool = z.infer<typeof executorToolSchema>;
export type ExecutorFailure = z.infer<typeof executorFailureSchema>;

/** An expired status snapshot is unknown; a confirmed interruption stays blocked until rechecked. */
export function executorObservationBlocks(observation: ExecutorObservation) {
  if (observation.state === "action_required") return true;
  if (observation.state !== "cooling_down") return false;
  return true;
}

export const resumeExecutorSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});
