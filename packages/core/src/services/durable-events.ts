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
  const [event] = await tx.insert(durableEvents).values({ ...input, sequence: stream.nextSequence }).returning();
  await tx.update(eventStreams).set({ nextSequence: sql`${eventStreams.nextSequence} + 1`, updatedAt: new Date() }).where(eq(eventStreams.projectId, input.projectId));
  return event!;
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
  return { status: "valid" as const, cursor: (rows.at(-1)?.sequence ?? position).toString(), retentionFloor: floor.toString(), events };
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
