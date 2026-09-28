import { z } from "zod";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const realtimeEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task_created"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("task_updated"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("task_status_changed"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    type: z.literal("task_commented"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("task_deleted"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_created"),
    projectId: z.string().uuid().nullable(),
    documentId: z.string().uuid(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("document_updated"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_deleted"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_linked"),
    sourceDocId: z.string().uuid(),
    targetDocId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_unlinked"),
    linkId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_task_linked"),
    documentId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_task_unlinked"),
    linkId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("requirement_created"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("requirement_updated"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("requirement_deleted"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("requirement_claimed"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
    claimedBy: z.string(),
  }),
  z.object({
    type: z.literal("requirement_released"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("repository_retry_requested"),
    projectId: z.string().uuid(),
    requirementId: z.string().uuid(),
    requirementRepositoryId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    targetRole: z.enum(["executor", "reviewer", "merger"]),
    targetPhase: z.enum(["execution", "review", "merge"]),
    resumeOperation: z.string().nullable(),
    nextAttemptAt: z.union([z.string(), z.date()]).nullable(),
  }),
  z.object({
    type: z.literal("task_claimed"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
    claimedBy: z.string(),
  }),
  z.object({
    type: z.literal("task_released"),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("daemon_status_changed"),
    daemonId: z.string().uuid(),
    instanceId: z.string().uuid().optional(),
    role: z.enum(["executor", "reviewer", "merger"]).optional(),
    actorId: z.string().nullable().optional(),
    actorType: z.enum(["human", "agent"]).nullable().optional(),
    host: z.string().nullable().optional(),
    processStartedAt: z.union([z.string(), z.date()]).nullable().optional(),
    workerCapacity: z.number().int().min(1).optional(),
    status: z.enum(["idle", "busy", "offline"]),
    controlState: z.enum(["running", "paused", "draining", "drained"]).optional(),
    controlReason: z.string().nullable().optional(),
    activeTaskIds: z.array(z.string().uuid()).optional(),
    activeWorkerStates: z.array(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("daemon_progress_updated"),
    projectId: z.string().uuid().nullable(),
    daemonId: z.string().uuid(),
    runId: z.string().uuid(),
    workerIndex: z.number().int().min(0),
    requirementId: z.string().uuid(),
    executionSliceId: z.string().uuid().nullable(),
    currentTaskId: z.string().uuid().nullable(),
    phase: z.string(),
    message: z.string().nullable(),
    workspaceState: z.string(),
    recoveryDisposition: z.string(),
    retryCount: z.number().int().min(0),
    source: z.string(),
    version: z.number().int().positive(),
    lastEventAt: z.union([z.string(), z.date()]),
  }),
  z.object({
    type: z.literal("schedule_created"),
    projectId: z.string().uuid().nullable(),
    scheduleId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("schedule_updated"),
    projectId: z.string().uuid().nullable(),
    scheduleId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("schedule_run_created"),
    projectId: z.string().uuid().nullable(),
    scheduleId: z.string().uuid(),
    runId: z.string().uuid(),
    taskId: z.string().uuid().nullable(),
  }),
]);

// Optional on the wire for backwards compatibility with older producers. The
// emitter fills the envelope for every event before local/PG delivery.
const realtimeEventMetadataSchema = z.object({
  eventId: z.string().uuid().optional(),
  runId: z.string().uuid().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).max(255).optional(),
  serverTime: z.string().datetime({ offset: true }).optional(),
  severity: z.enum(["debug", "info", "warn", "error"]).optional(),
  source: z.enum(["daemon", "worker", "task_status", "recovery", "system", "api"]).optional(),
  attributes: z.record(z.unknown()).optional(),
});

export const realtimeEventSchema = z.intersection(
  realtimeEventPayloadSchema,
  realtimeEventMetadataSchema,
);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export { acceptRealtimeSequence } from "./sequence";

const CHANNEL = "task_weaver_events";

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
let sql: postgres.Sql | null = null;
let initialized = false;
let sequence = 0;

/**
 * Initialize the realtime system with a PostgreSQL connection.
 * Uses PG LISTEN/NOTIFY for cross-process event delivery.
 * Must be called before subscribe() or emit() to enable PG transport.
 */
export async function initRealtime(connectionString: string): Promise<void> {
  if (initialized) return;

  sql = postgres(connectionString, {
    max: 2,
    idle_timeout: 0,
    max_lifetime: null,
  });

  await sql.listen(CHANNEL, (payload) => {
    try {
      const parsed = JSON.parse(payload);
      const result = realtimeEventSchema.safeParse(parsed);
      if (!result.success) return;

      for (const listener of listeners) {
        try {
          listener(result.data);
        } catch {
          // Don't let a broken listener kill the dispatch
        }
      }
    } catch {
      // Ignore malformed payloads
    }
  });

  initialized = true;
}

/**
 * Subscribe to realtime events. Receives events from all processes
 * (via PG NOTIFY) when initRealtime() has been called, or only
 * same-process events as fallback.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Emit a realtime event. If PG is initialized, sends via NOTIFY
 * (all listening processes receive it). Otherwise falls back to
 * in-process dispatch only.
 */
export function emit(event: RealtimeEvent): void {
  const now = new Date();
  const nextSequence = event.sequence ?? ++sequence;
  sequence = Math.max(sequence, nextSequence);
  const metadata = {
    eventId: event.eventId ?? randomUUID(),
    sequence: nextSequence,
    cursor: event.cursor ?? `${now.getTime()}-${nextSequence}`,
    serverTime: event.serverTime ?? now.toISOString(),
    severity: event.severity ?? "info",
    source: event.source ?? ((event as { type: string }).type === "daemon_progress_updated" ? "worker" : "system"),
    attributes: event.attributes ?? {},
  } as const;
  // Keep the local listener shape backwards-compatible while exposing the
  // envelope through normal property access and serialized transports.
  const enriched = { ...event } as RealtimeEvent;
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(enriched, key, { value, enumerable: false, configurable: true });
  }

  if (sql) {
    sql.notify(CHANNEL, serializeRealtimeEvent(enriched)).catch((err) => {
      console.error("Failed to send PG NOTIFY:", err);
    });
    return;
  }

  // Fallback: in-process only (no PG connection)
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      // Don't let a broken listener kill the emitter
    }
  }
}

/** Serialize a realtime event including its non-enumerable local envelope. */
export function serializeRealtimeEvent(event: RealtimeEvent) {
  return JSON.stringify({
    ...event,
    eventId: event.eventId,
    sequence: event.sequence,
    cursor: event.cursor,
    serverTime: event.serverTime,
    severity: event.severity,
    source: event.source,
    attributes: event.attributes,
  });
}

/**
 * Shut down the realtime system and close the PG connection.
 */
export async function shutdown(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
  initialized = false;
  sequence = 0;
  listeners.clear();
}
