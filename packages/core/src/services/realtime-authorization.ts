import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { type Database, schedules, daemonWorkerProgress, daemons, activityLog, documents } from "@task-weaver/db";
import { AuthorizationError, NotFoundError, type VerifiedRequestContext, type RealtimeEvent } from "@task-weaver/contracts";
import { subscribe } from "@task-weaver/realtime";
import { lockIdentityLifecycle } from "./auth-security";
import { canAccessResource, resourceAuthority, requireResource, type ResourceAuthority } from "./resource-authorization";
import { authorizeMetadataOperation } from "./metadata-authorization";
import { metadataReadScope } from "./metadata-read-scope";
import { requireRepository } from "./repository-authorization";

/** Event payloads are invalidation hints, never a substitute for authorized detail reads. */
export async function authorizedRealtimeEvent(db: Database, authority: ResourceAuthority, event: RealtimeEvent): Promise<Record<string, unknown> | null> {
  if (authority.bounds) {
    if (!/^(task_|document_|requirement_)/.test(event.type)) return null;
    if (event.type === "document_deleted" && !authority.bounds.documentIds.includes(event.documentId)) return null;
  }
  const value = event as RealtimeEvent & Record<string, any>;
  const output: Record<string, unknown> = { type: event.type };
  async function resource(kind: "task" | "document" | "requirement" | "slice", id: string, key: string) {
    const scope = await requireResource(db, authority, kind, id);
    if ("projectId" in value && value.projectId !== undefined && value.projectId !== (scope.projectId ?? null)) throw new NotFoundError("Resource not found");
    output[key] = id;
    if (scope.projectId) output.projectId = scope.projectId;
  }
  try {
    if (event.type.startsWith("task_")) {
      await resource("task", value.taskId, "taskId");
    } else if (event.type.startsWith("requirement_")) {
      await resource("requirement", value.requirementId, "requirementId");
    } else if (event.type.startsWith("document_")) {
      if (event.type === "document_deleted") {
        if (await db.query.documents.findFirst({ where: eq(documents.id, event.documentId) })) return null;
        const rows = await db.select({ metadata: activityLog.metadata }).from(activityLog).where(and(eq(activityLog.entityId, event.documentId), eq(activityLog.entityType, "document"), eq(activityLog.action, "deleted")));
        const metadata = rows.find(row => row.metadata && typeof row.metadata === "object" && "deletedResourceScope" in row.metadata)?.metadata as Record<string, any> | undefined;
        const scope = metadata?.deletedResourceScope;
        if (!scope || !canAccessResource(authority, scope)) return null;
        output.documentId = event.documentId;
        if (scope.projectId) output.projectId = scope.projectId;
        return output;
      }
      if (value.documentId) await resource("document", value.documentId, "documentId");
      else if (value.sourceDocId && value.targetDocId) {
        await resource("document", value.sourceDocId, "sourceDocId");
        await resource("document", value.targetDocId, "targetDocId");
      } else return null;
      if (value.taskId) await resource("task", value.taskId, "taskId");
      if (value.linkId) output.linkId = value.linkId;
    } else if (event.type.startsWith("schedule_")) {
      await authorizeMetadataOperation(db, authority, "schedule", "getSchedule", [db, value.scheduleId]);
      const row = await db.query.schedules.findFirst({ where: eq(schedules.id, value.scheduleId) });
      if (!row || value.projectId !== row.projectId) return null;
      output.scheduleId = row.id;
      if (row.projectId) output.projectId = row.projectId;
      if (value.taskId) await resource("task", value.taskId, "taskId");
      // Run identifiers are resolved by the scoped schedule detail endpoint.
    } else if (event.type === "daemon_progress_updated") {
      const scope = metadataReadScope(db, authority);
      const [row] = await db.select().from(daemonWorkerProgress).where(and(eq(daemonWorkerProgress.runId, event.runId), eq(daemonWorkerProgress.daemonId, event.daemonId), scope.progress)).limit(1);
      if (!row || row.requirementId !== event.requirementId || row.currentTaskId !== event.currentTaskId || row.executionSliceId !== event.executionSliceId) return null;
      await resource("requirement", row.requirementId, "requirementId");
      if (row.currentTaskId) await resource("task", row.currentTaskId, "currentTaskId");
      if (row.executionSliceId) await resource("slice", row.executionSliceId, "executionSliceId");
      output.daemonId = row.daemonId;
    } else if (event.type === "daemon_status_changed") {
      const [row] = await db.select({ id: daemons.id }).from(daemons).where(and(eq(daemons.id, event.daemonId), metadataReadScope(db, authority).daemon)).limit(1);
      if (!row) return null;
      // Self-reported worker states, host/control reason and task lists span multiple projects.
      output.daemonId = row.id;
    } else if (event.type === "repository_retry_requested") {
      await resource("requirement", event.requirementId, "requirementId");
      await requireRepository(db, authority, event.repositoryId);
      output.repositoryId = event.repositoryId;
    } else return null;
    return output;
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof AuthorizationError) return null;
    throw error;
  }
}

function authorityFingerprint(authority: ResourceAuthority) {
  return JSON.stringify({ actor: authority.actor, grants: authority.grants.map(g => JSON.stringify({ ...g, permissions: [...g.permissions].sort() })).sort() });
}

/** No replay buffer exists. Reconnects receive an explicit resync without echoing untrusted cursors. */
export async function createAuthorizedEventStream(db: Database, context: VerifiedRequestContext, request: Request, options: { daemon?: boolean; heartbeatMs?: number } = {}): Promise<Response> {
  const initial = await resourceAuthority(db, context);
  const fingerprint = authorityFingerprint(initial);
  const connectionId = randomUUID();
  let sequence = 0;
  let closed = false;
  let pending = 0;
  let queue = Promise.resolve();
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(timer);
    request.signal.removeEventListener("abort", close);
    try { controller.close(); } catch { /* The reader may already have cancelled. */ }
  }
  function write(type: string, data: unknown, id?: string) {
    if (closed) return;
    if (controller.desiredSize !== null && controller.desiredSize < -64) { close(); return; }
    controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  }
  function enqueue(event?: RealtimeEvent) {
    if (closed) return;
    if (++pending > 64) { close(); return; }
    queue = queue.then(async () => {
      if (closed) return;
      await db.transaction(async tx => {
        await lockIdentityLifecycle(tx);
        const authority = await resourceAuthority(tx, context);
        if (authorityFingerprint(authority) !== fingerprint) { close(); return; }
        if (!event) { write("heartbeat", {}); return; }
        if (options.daemon && !["task_created", "task_released", "requirement_created", "requirement_released", "repository_retry_requested"].includes(event.type)) return;
        const payload = await authorizedRealtimeEvent(tx as unknown as Database, authority, event);
        if (payload) write(event.type, { ...payload, sequence: ++sequence }, `${connectionId}-${sequence}`);
      });
    }).catch(() => close()).finally(() => { pending--; });
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      // Resume identifiers are connection-local; all reconnects refetch authorized current state.
      write("connected", { resume: "resync" });
      unsubscribe = subscribe(enqueue);
      timer = setInterval(() => enqueue(), options.heartbeatMs ?? 1000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel: close,
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
