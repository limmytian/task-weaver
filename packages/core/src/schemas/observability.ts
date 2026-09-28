import { z } from "zod";

/** Shared vocabulary used by API, CLI, Web, and realtime projections. */
export const observabilityLivenessSchema = z.enum(["online", "stale", "offline"]);
export const observabilityHealthSchema = z.enum(["healthy", "degraded", "unhealthy", "unknown"]);
export const observabilitySeveritySchema = z.enum(["debug", "info", "warn", "error"]);
export const observabilityEventSourceSchema = z.enum([
  "daemon",
  "worker",
  "task_status",
  "recovery",
  "system",
  "api",
]);
export const observabilityNextActionKindSchema = z.enum([
  "run",
  "wait",
  "retry",
  "review",
  "merge",
  "resume",
  "operator",
]);

export const observabilityForecastEntitySchema = z.object({
  kind: z.enum(["daemon", "worker", "requirement", "task", "slice", "repository", "claim", "capability", "operator"]),
  id: z.string().uuid().nullable(),
  label: z.string().min(1).max(500),
});

/**
 * Correlation metadata carried by every durable/realtime observability event.
 * `sequence` is monotonic within a run/worker stream and `cursor` is an opaque
 * continuation token; consumers must not parse either value.
 */
export const observabilityEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  sequence: z.number().int().nonnegative(),
  cursor: z.string().min(1).max(255),
  serverTime: z.string().datetime({ offset: true }),
  severity: observabilitySeveritySchema,
  source: observabilityEventSourceSchema,
  attributes: z.record(z.unknown()).default({}),
});

export const observabilityNextActionSchema = z.object({
  kind: observabilityNextActionKindSchema,
  reason: z.string().min(1).max(500),
  trigger: z.string().min(1).max(500),
  policy: z.string().min(1).max(200),
  at: z.string().datetime({ offset: true }).nullable(),
  nextActionAt: z.string().datetime({ offset: true }).nullable(),
  confidence: z.enum(["deterministic", "unknown"]),
  blockingEntity: observabilityForecastEntitySchema.nullable(),
  requiredRole: z.enum(["executor", "reviewer", "merger", "operator"]).nullable(),
  requiredCapability: z.string().min(1).max(120).nullable(),
  requirementId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  daemonId: z.string().uuid().nullable(),
  workerIndex: z.number().int().min(0).nullable(),
});

export const observabilityAlertSchema = z.object({
  code: z.enum([
    "daemon_offline",
    "daemon_stale",
    "lease_at_risk",
    "worker_failed",
    "worker_no_progress",
    "queue_blocked",
  ]),
  severity: z.enum(["info", "warn", "error"]),
  message: z.string().min(1).max(500),
  daemonId: z.string().uuid().nullable(),
  requirementId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
});

export const daemonObservabilityQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  includeOffline: z.preprocess((value) => {
    if (value === undefined) return true;
    if (value === true || value === false) return value;
    return value === "true" || value === "1";
  }, z.boolean()),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type ObservabilityLiveness = z.infer<typeof observabilityLivenessSchema>;
export type ObservabilityHealth = z.infer<typeof observabilityHealthSchema>;
export type ObservabilityEventSource = z.infer<typeof observabilityEventSourceSchema>;
export type ObservabilitySeverity = z.infer<typeof observabilitySeveritySchema>;
export type ObservabilityEventEnvelope = z.infer<typeof observabilityEventEnvelopeSchema>;
export type ObservabilityNextAction = z.infer<typeof observabilityNextActionSchema>;
export type ObservabilityForecastEntity = z.infer<typeof observabilityForecastEntitySchema>;
export type ObservabilityAlert = z.infer<typeof observabilityAlertSchema>;
export type DaemonObservabilityQuery = z.infer<typeof daemonObservabilityQuerySchema>;

const SECRET_KEY = /(authorization|api[-_]?key|password|passwd|secret|token|credential|private[-_]?key)/i;
const SECRET_VALUE = /(bearer\s+)[^\s]+/gi;
const MAX_ATTRIBUTE_DEPTH = 4;
const MAX_ATTRIBUTE_KEYS = 64;
const MAX_ATTRIBUTE_STRING = 2_000;
const MAX_ATTRIBUTE_BYTES = 8_000;

export function redactObservabilityText(value: string, maxLength = MAX_ATTRIBUTE_STRING) {
  const redacted = value.replace(SECRET_VALUE, "$1[redacted]");
  if (redacted.length <= maxLength) return { value: redacted, truncated: false };
  return { value: `${redacted.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true };
}

function redactValue(value: unknown, depth: number): { value: unknown; truncated: boolean } {
  if (typeof value === "string") return redactObservabilityText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, truncated: false };
  }
  if (depth >= MAX_ATTRIBUTE_DEPTH) return { value: "[truncated]", truncated: true };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let truncated = false;
    for (const item of value.slice(0, MAX_ATTRIBUTE_KEYS)) {
      const result = redactValue(item, depth + 1);
      output.push(result.value);
      truncated ||= result.truncated;
    }
    if (value.length > MAX_ATTRIBUTE_KEYS) truncated = true;
    return { value: output, truncated };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    let truncated = false;
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ATTRIBUTE_KEYS)) {
      if (SECRET_KEY.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      const result = redactValue(item, depth + 1);
      output[key] = result.value;
      truncated ||= result.truncated;
    }
    if (Object.keys(value as Record<string, unknown>).length > MAX_ATTRIBUTE_KEYS) truncated = true;
    return { value: output, truncated };
  }
  return { value: String(value), truncated: true };
}

/** Redact secrets and cap structured event attributes before persistence. */
export function redactObservabilityAttributes(attributes: Record<string, unknown>) {
  const result = redactValue(attributes, 0);
  let value = result.value as Record<string, unknown>;
  let truncated = result.truncated;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_ATTRIBUTE_BYTES) {
      value = {
        ...Object.fromEntries(Object.entries(value).slice(0, 16)),
        _truncated: true,
      };
      truncated = true;
    }
  } catch {
    value = { _redacted: true, _truncated: true };
    truncated = true;
  }
  return { value, truncated };
}

export function isProgressTransitionValid(previous: string | null | undefined, next: string) {
  if (!previous || previous === next) return true;
  const transitions: Record<string, string[]> = {
    claiming: ["executing", "recovering", "failed", "cancelled"],
    executing: ["task_completed", "awaiting_review", "recovering", "failed", "cancelled"],
    task_completed: ["executing", "awaiting_review", "reviewing", "merging", "completed", "recovering", "failed"],
    awaiting_review: ["reviewing", "recovering", "failed", "cancelled"],
    reviewing: ["merging", "awaiting_review", "recovering", "failed", "cancelled"],
    merging: ["finalizing", "recovering", "failed", "cancelled"],
    finalizing: ["completed", "recovering", "failed"],
    recovering: ["claiming", "executing", "reviewing", "merging", "quarantined", "failed"],
    quarantined: ["recovering", "failed", "cancelled"],
    completed: [],
    failed: ["recovering", "claiming"],
    cancelled: [],
  };
  return transitions[previous]?.includes(next) ?? false;
}
