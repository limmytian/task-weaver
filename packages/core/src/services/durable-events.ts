import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { webhookEvents, type Database } from "@task-weaver/db";
import { emit, serializeRealtimeEvent, type RealtimeEvent } from "@task-weaver/realtime";
import type { Actor } from "@task-weaver/contracts";

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
import { durableEvents, eventConsumers, eventStreams } from "@task-weaver/db";
import { eventCursorSchema } from "@task-weaver/contracts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EventRow = typeof durableEvents.$inferSelect;
export type EventAuthorization = {
  // Implementations must consult current grants and validate every resource in scope.
  project(projectId: string): Promise<void>;
  event(event: EventRow): Promise<boolean>;
  consumer(projectId: string, name: string): Promise<void>;
};

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
export async function replayDurableEvents(db: Database, input: { projectId: string; cursor: string; limit?: number }, auth: EventAuthorization) {
  const position = cursor(input.cursor);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Event batch limit must be between 1 and 500");
  await auth.project(input.projectId);
  const [stream] = await db.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId));
  const floor = stream?.retentionFloor ?? 0n, head = (stream?.nextSequence ?? 1n) - 1n;
  if (position < floor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: floor.toString() };
  if (position > head) throw new Error("Event cursor is ahead of the stream");
  const rows = await db.select().from(durableEvents).where(and(eq(durableEvents.projectId, input.projectId), gt(durableEvents.sequence, position))).orderBy(asc(durableEvents.sequence)).limit(limit);
  const events: ReturnType<typeof serialize>[] = [];
  for (const row of rows) {
    await auth.project(input.projectId);
    if (await auth.event(row)) events.push(serialize(row));
  }
  await auth.project(input.projectId);
  // Retention may have advanced while authorization checks were running.
  const [current] = await db.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId));
  const currentFloor = current?.retentionFloor ?? 0n;
  if (position < currentFloor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: currentFloor.toString() };
  // Recheck each selected resource before returning, including previously allowed rows.
  const visible = [] as typeof events;
  for (const event of events) {
    await auth.project(input.projectId);
    const row = rows.find(candidate => candidate.id === event.id)!;
    if (await auth.event(row)) visible.push(event);
  }
  await auth.project(input.projectId);
  return { status: "valid" as const, cursor: (rows.at(-1)?.sequence ?? position).toString(), retentionFloor: currentFloor.toString(), events: visible };
}

/** Acknowledgments are monotonic and idempotent per project and consumer. */
export async function acknowledgeDurableEvents(db: Database, input: { projectId: string; consumer: string; cursor: string }, auth: EventAuthorization) {
  const position = cursor(input.cursor);
  if (!input.consumer.trim()) throw new Error("Consumer name is required");
  await auth.project(input.projectId);
  await auth.consumer(input.projectId, input.consumer);
  return db.transaction(async tx => {
    await tx.insert(eventStreams).values({ projectId: input.projectId }).onConflictDoNothing();
    const [stream] = await tx.select().from(eventStreams).where(eq(eventStreams.projectId, input.projectId)).for("update");
    if (!stream) throw new Error("Event stream unavailable");
    if (position < stream.retentionFloor) return { status: "expired" as const, cursor: input.cursor, retentionFloor: stream.retentionFloor.toString() };
    if (position >= stream.nextSequence) throw new Error("Event cursor is ahead of the stream");
    await auth.project(input.projectId);
    await auth.consumer(input.projectId, input.consumer);
    const [consumer] = await tx.insert(eventConsumers).values({ projectId: input.projectId, name: input.consumer, acknowledgedSequence: position }).onConflictDoUpdate({
      target: [eventConsumers.projectId, eventConsumers.name],
      set: { acknowledgedSequence: sql`greatest(${eventConsumers.acknowledgedSequence}, ${position})`, updatedAt: new Date() },
    }).returning();
    return { status: "valid" as const, cursor: consumer!.acknowledgedSequence.toString(), retentionFloor: stream.retentionFloor.toString() };
  });
}

/** Read the durable checkpoint only after authorizing its consumer identity. */
export async function getDurableEventCheckpoint(db: Database, input: { projectId: string; consumer: string }, auth: EventAuthorization) {
  if (!input.consumer.trim()) throw new Error("Consumer name is required");
  await auth.project(input.projectId);
  await auth.consumer(input.projectId, input.consumer);
  const [row] = await db.select().from(eventConsumers).where(and(eq(eventConsumers.projectId, input.projectId), eq(eventConsumers.name, input.consumer)));
  await auth.project(input.projectId);
  await auth.consumer(input.projectId, input.consumer);
  return { cursor: (row?.acknowledgedSequence ?? 0n).toString() };
}
