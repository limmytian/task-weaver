import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { webhookEvents, type Database } from "@task-weaver/db";
import { emit, serializeRealtimeEvent, type RealtimeEvent } from "@task-weaver/realtime";
import { AuthorizationError, NotFoundError, type Actor, type VerifiedRequestContext } from "@task-weaver/contracts";
import { lockIdentityLifecycle } from "./auth-security";
import { resourceAuthority, requireResource } from "./resource-authorization";
import { requirements, tasks, executionSlices } from "@task-weaver/db";

const context = new AsyncLocalStorage<{ actor: Actor; causationId?: string; correlationId?: string }>();
export const withEventActor = <T>(actor: Actor, work: () => Promise<T>, linkage?: { causationId: string; correlationId: string }) => context.run({ ...context.getStore(), actor, ...linkage }, work);

/** Await inside the business transaction. Realtime notifications remain hints; the outbox is authoritative. */
export async function emitDurable(db: Database, event: RealtimeEvent) {
  const id = event.eventId ?? randomUUID();
  const occurredAt = new Date(event.serverTime ?? Date.now());
  const scope = context.getStore();
  const enriched = { ...event, eventId: id, serverTime: occurredAt.toISOString(), attributes: { ...event.attributes, durableOutbox: true } } as RealtimeEvent;
  await db.insert(webhookEvents).values({ id, eventType: event.type,
    projectId: "projectId" in event ? event.projectId : null,
    actorId: scope?.actor.id, actorType: scope?.actor.type, causationId: scope?.causationId,
    correlationId: scope?.correlationId ?? id, event: JSON.parse(serializeRealtimeEvent(enriched)), occurredAt }).onConflictDoNothing();
  emit(enriched);
}
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { durableEvents, eventConsumers, eventStreams, eventCursorIncidents } from "@task-weaver/db";
import { eventCursorSchema, planChangedEventScopeSchema } from "@task-weaver/contracts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EventRow = typeof durableEvents.$inferSelect;
async function authorizeEvent(tx: Transaction, authority: Awaited<ReturnType<typeof resourceAuthority>>, row: EventRow) {
  if (row.type !== "plan.changed" || row.version !== 1) return false;
  const parsed = planChangedEventScopeSchema.safeParse(row.scope);
  if (!parsed.success) return false;
  const { requirementId, taskId, sliceId } = parsed.data;
  // Lock resource rows so deletion or reassignment cannot race the disclosure.
  const [requirement] = await tx.select().from(requirements).where(eq(requirements.id, requirementId)).for("share");
  if (!requirement || requirement.projectId !== row.projectId) return false;
  try {
    await requireResource(tx as unknown as Database, authority, "requirement", requirementId);
    if (sliceId) {
      const [slice] = await tx.select().from(executionSlices).where(eq(executionSlices.id, sliceId)).for("share");
      if (!slice || slice.requirementId !== requirementId) return false;
      await requireResource(tx as unknown as Database, authority, "slice", sliceId);
    }
    if (taskId) {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("share");
      if (!task || task.projectId !== row.projectId || task.requirementId !== requirementId || (sliceId && task.executionSliceId !== sliceId)) return false;
      await requireResource(tx as unknown as Database, authority, "task", taskId);
    }
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof NotFoundError) return false;
    throw error;
  }
}

async function withEventAuthority<T>(db: Database, context: VerifiedRequestContext, projectId: string, work: (tx: Transaction, authority: Awaited<ReturnType<typeof resourceAuthority>>) => Promise<T>) {
  return db.transaction(async tx => {
    await lockIdentityLifecycle(tx);
    const authority = await resourceAuthority(tx, context);
    await requireResource(tx as unknown as Database, authority, "project", projectId);
    return work(tx, authority);
  });
}

/** Append inside the same transaction as the change that caused the event. */
export async function appendDurableEvent(tx: Transaction, input: Omit<typeof durableEvents.$inferInsert, "sequence" | "recordedAt">) {
  await tx.insert(eventStreams).values({ projectId: input.projectId }).onConflictDoNothing();
  const [stream] = await tx.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId)).for("update");
  if (!stream) throw new Error("Event stream unavailable");
  const [event] = await tx.insert(durableEvents).values({ ...input, sequence: stream.nextSequence }).onConflictDoNothing({ target: durableEvents.id }).returning();
  if (!event) {
    const [existing] = await tx.select().from(durableEvents).where(eq(durableEvents.id, input.id!));
    // An ID identifies one immutable event. Never treat a conflicting retry as success.
    if (!existing || existing.projectId !== input.projectId || existing.type !== input.type || existing.version !== input.version ||
        existing.occurredAt.getTime() !== input.occurredAt.getTime() ||
        !sameJson(existing.scope, input.scope) || !sameJson(existing.payload, input.payload)) throw new Error("Event ID conflicts with an existing event");
    return existing;
  }
  await tx.update(eventStreams).set({ nextSequence: sql`${eventStreams.nextSequence} + 1`, updatedAt: new Date() }).where(eq(eventStreams.projectId, input.projectId));
  return event!;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const left = Object.keys(a as object).sort(), right = Object.keys(b as object).sort();
  return left.length === right.length && left.every((key, i) => key === right[i] && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function cursor(value: string) { return BigInt(eventCursorSchema.parse(value)); }
function serialize(event: EventRow) {
  return { ...event, sequence: event.sequence.toString(), occurredAt: event.occurredAt.toISOString(), recordedAt: event.recordedAt.toISOString() };
}

/** The returned cursor advances over inspected events, including inaccessible ones. */
export async function replayDurableEvents(db: Database, input: { projectId: string; cursor: string; limit?: number }, context: VerifiedRequestContext) {
  const position = cursor(input.cursor);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Event batch limit must be between 1 and 500");
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [stream] = await tx.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId)).for("share");
    const floor = stream?.retentionFloor ?? 0n, head = (stream?.nextSequence ?? 1n) - 1n;
    if (position < floor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: floor.toString() };
    if (position > head) throw new Error("Event cursor is ahead of the stream");
    const rows = await tx.select().from(durableEvents).where(and(eq(durableEvents.projectId, input.projectId), gt(durableEvents.sequence, position))).orderBy(asc(durableEvents.sequence)).limit(limit);
    const events: ReturnType<typeof serialize>[] = [];
    for (const row of rows) if (await authorizeEvent(tx, authority, row)) events.push(serialize(row));
    return { status: "valid" as const, cursor: (rows.at(-1)?.sequence ?? position).toString(), retentionFloor: floor.toString(), events };
  });
}

/** Acknowledgments are monotonic and owned by the authenticated principal. */
export async function acknowledgeDurableEvents(db: Database, input: { projectId: string; consumer: string; cursor: string }, context: VerifiedRequestContext) {
  const position = cursor(input.cursor);
  if (!input.consumer.trim()) throw new Error("Consumer name is required");
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    await tx.insert(eventStreams).values({ projectId: input.projectId }).onConflictDoNothing();
    const [stream] = await tx.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId)).for("update");
    if (!stream) throw new Error("Event stream unavailable");
    if (position < stream.retentionFloor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: stream.retentionFloor.toString() };
    if (position >= stream.nextSequence) throw new Error("Event cursor is ahead of the stream");
    const [consumer] = await tx.insert(eventConsumers).values({ projectId: input.projectId, principalType: authority.actor.type, principalId: authority.actor.id, name: input.consumer, acknowledgedSequence: position }).onConflictDoUpdate({
      target: [eventConsumers.projectId, eventConsumers.principalType, eventConsumers.principalId, eventConsumers.name],
      set: { acknowledgedSequence: sql`greatest(${eventConsumers.acknowledgedSequence}, ${position})`, updatedAt: new Date() },
      setWhere: eq(eventConsumers.leaseGeneration, 0n),
    }).returning();
    if (!consumer) throw new Error("Consumer requires a fenced acknowledgment");
    return { status: "valid" as const, cursor: consumer!.acknowledgedSequence.toString(), retentionFloor: stream.retentionFloor.toString() };
  });
}

export async function getDurableEventCheckpoint(db: Database, input: { projectId: string; consumer: string }, context: VerifiedRequestContext) {
  if (!input.consumer.trim()) throw new Error("Consumer name is required");
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [row] = await tx.select().from(eventConsumers).where(and(eq(eventConsumers.projectId, input.projectId), eq(eventConsumers.principalType, authority.actor.type), eq(eventConsumers.principalId, authority.actor.id), eq(eventConsumers.name, input.consumer)));
    const [stream] = await tx.select({ retentionFloor: eventStreams.retentionFloor }).from(eventStreams).where(eq(eventStreams.projectId, input.projectId));
    const position = row?.acknowledgedSequence ?? 0n, floor = stream?.retentionFloor ?? 0n;
    return { status: position < floor ? "expired" as const : "valid" as const, cursor: position.toString(), retentionFloor: floor.toString() };
  });
}

const MAX_LEASE_MS = 5 * 60 * 1000;
function validateLeaseInput(input: { consumer: string; owner: string; durationMs: number }) {
  if (!input.consumer.trim()) throw new Error("Consumer name is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.owner)) throw new Error("Lease owner must be a UUID");
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1000 || input.durationMs > MAX_LEASE_MS) throw new Error("Lease duration must be between 1000 and 300000 milliseconds");
}

/** A new acquisition increments the fence, including after expiry by the same owner. */
export async function acquireDurableConsumerLease(db: Database, input: { projectId: string; consumer: string; owner: string; durationMs: number }, context: VerifiedRequestContext) {
  validateLeaseInput(input);
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    await tx.insert(eventStreams).values({ projectId: input.projectId }).onConflictDoNothing();
    await tx.insert(eventConsumers).values({ projectId: input.projectId, principalType: authority.actor.type, principalId: authority.actor.id, name: input.consumer }).onConflictDoNothing();
    const [lease] = await tx.update(eventConsumers).set({ leaseOwner: input.owner, leaseGeneration: sql`${eventConsumers.leaseGeneration} + 1`, leaseExpiresAt: sql`clock_timestamp() + ${input.durationMs} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()` }).where(and(eq(eventConsumers.projectId, input.projectId), eq(eventConsumers.principalType, authority.actor.type), eq(eventConsumers.principalId, authority.actor.id), eq(eventConsumers.name, input.consumer), sql`(${eventConsumers.leaseExpiresAt} IS NULL OR ${eventConsumers.leaseExpiresAt} <= clock_timestamp())`)).returning();
    return lease ? { status: "acquired" as const, generation: lease.leaseGeneration.toString(), expiresAt: lease.leaseExpiresAt!.toISOString() } : { status: "busy" as const };
  });
}

export async function renewDurableConsumerLease(db: Database, input: { projectId: string; consumer: string; owner: string; generation: string; durationMs: number }, context: VerifiedRequestContext) {
  validateLeaseInput(input);
  const generation = cursor(input.generation);
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [lease] = await tx.update(eventConsumers).set({ leaseExpiresAt: sql`clock_timestamp() + ${input.durationMs} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()` }).where(and(eq(eventConsumers.projectId, input.projectId), eq(eventConsumers.principalType, authority.actor.type), eq(eventConsumers.principalId, authority.actor.id), eq(eventConsumers.name, input.consumer), eq(eventConsumers.leaseOwner, input.owner), eq(eventConsumers.leaseGeneration, generation), sql`${eventConsumers.leaseExpiresAt} > clock_timestamp()`)).returning();
    if (!lease) throw new Error("Consumer lease is stale or expired");
    return { generation: lease.leaseGeneration.toString(), expiresAt: lease.leaseExpiresAt!.toISOString() };
  });
}

/** Atomically validate the live fence and advance the principal's checkpoint. */
export async function acknowledgeDurableEventsFenced(db: Database, input: { projectId: string; consumer: string; cursor: string; owner: string; generation: string }, context: VerifiedRequestContext) {
  validateLeaseInput({ ...input, durationMs: 1000 });
  const position = cursor(input.cursor), generation = cursor(input.generation);
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [stream] = await tx.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId)).for("update");
    if (!stream) throw new Error("Consumer lease is stale or expired");
    const [lease] = await tx.select().from(eventConsumers).where(and(eq(eventConsumers.projectId, input.projectId), eq(eventConsumers.principalType, authority.actor.type), eq(eventConsumers.principalId, authority.actor.id), eq(eventConsumers.name, input.consumer))).for("update");
    // Check expiry using the database clock after waiting for the row lock.
    const [updated] = lease && await tx.update(eventConsumers).set({ acknowledgedSequence: sql`greatest(${eventConsumers.acknowledgedSequence}, ${position})`, updatedAt: sql`clock_timestamp()` }).where(and(eq(eventConsumers.id, lease.id), eq(eventConsumers.leaseOwner, input.owner), eq(eventConsumers.leaseGeneration, generation), sql`${eventConsumers.leaseExpiresAt} > clock_timestamp()`, sql`${position} >= ${stream.retentionFloor} AND ${position} < ${stream.nextSequence}`)).returning() || [];
    if (!lease || lease.leaseOwner !== input.owner || lease.leaseGeneration !== generation) throw new Error("Consumer lease is stale or expired");
    if (!updated) {
      // Validate the fence even when the cursor is invalid.
      const [live] = await tx.select({ id: eventConsumers.id }).from(eventConsumers).where(and(eq(eventConsumers.id, lease.id), sql`${eventConsumers.leaseExpiresAt} > clock_timestamp()`));
      if (!live) throw new Error("Consumer lease is stale or expired");
      if (position < stream.retentionFloor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: stream.retentionFloor.toString() };
      throw new Error("Event cursor is ahead of the stream");
    }
    return { status: "valid" as const, cursor: updated.acknowledgedSequence.toString(), retentionFloor: stream.retentionFloor.toString() };
  });
}

/** Record an expired cursor without modifying the consumer checkpoint. */
export async function recordEventCursorIncident(db: Database, input: { projectId: string; consumer: string; cursor: string; retentionFloor: string }, context: VerifiedRequestContext) {
  const position = cursor(input.cursor), floor = cursor(input.retentionFloor);
  if (!input.consumer.trim() || position >= floor) throw new Error("An expired cursor and consumer name are required");
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [incident] = await tx.insert(eventCursorIncidents).values({ projectId: input.projectId, principalType: authority.actor.type, principalId: authority.actor.id, consumer: input.consumer, cursor: position, retentionFloor: floor }).onConflictDoUpdate({
      target: [eventCursorIncidents.projectId, eventCursorIncidents.principalType, eventCursorIncidents.principalId, eventCursorIncidents.consumer],
      targetWhere: sql`${eventCursorIncidents.resolvedAt} IS NULL`,
      set: { cursor: position, retentionFloor: floor, updatedAt: sql`clock_timestamp()` },
    }).returning();
    return serializeIncident(incident!);
  });
}

function serializeIncident(row: typeof eventCursorIncidents.$inferSelect) {
  return { ...row, cursor: row.cursor.toString(), retentionFloor: row.retentionFloor.toString() };
}

export async function inspectEventCursorIncidents(db: Database, input: { projectId: string }, context: VerifiedRequestContext) {
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const rows = await tx.select().from(eventCursorIncidents).where(and(eq(eventCursorIncidents.projectId, input.projectId), eq(eventCursorIncidents.principalType, authority.actor.type), eq(eventCursorIncidents.principalId, authority.actor.id))).orderBy(asc(eventCursorIncidents.createdAt));
    return rows.map(serializeIncident);
  });
}

/** Resolve only the caller's open incident; resolution does not advance a cursor. */
export async function resolveEventCursorIncident(db: Database, input: { projectId: string; incidentId: string }, context: VerifiedRequestContext) {
  return withEventAuthority(db, context, input.projectId, async (tx, authority) => {
    const [row] = await tx.update(eventCursorIncidents).set({ resolvedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(and(eq(eventCursorIncidents.id, input.incidentId), eq(eventCursorIncidents.projectId, input.projectId), eq(eventCursorIncidents.principalType, authority.actor.type), eq(eventCursorIncidents.principalId, authority.actor.id), sql`${eventCursorIncidents.resolvedAt} IS NULL`)).returning();
    if (!row) throw new Error("Open event cursor incident not found");
    return serializeIncident(row);
  });
}
