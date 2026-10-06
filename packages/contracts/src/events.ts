import { z } from "zod";

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
    sourceDocId: z.string().uuid().optional(),
    targetDocId: z.string().uuid().optional(),
    linkId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_task_linked"),
    documentId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("document_task_unlinked"),
    documentId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
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
// emitter fills the envelope for every event before local or PostgreSQL delivery.
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

/** Decide whether a sequenced event can be applied after a reconnect. */
export function acceptRealtimeSequence(lastSequence: number, nextSequence: number) {
  if (nextSequence <= lastSequence) return { accepted: false, missed: false };
  return {
    accepted: true,
    missed: lastSequence > 0 && nextSequence > lastSequence + 1,
  };
}
