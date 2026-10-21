import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { webhookEvents, type Database } from "@task-weaver/db";
import { emit, serializeRealtimeEvent, type RealtimeEvent } from "@task-weaver/realtime";
import type { Actor } from "@task-weaver/contracts";

const context = new AsyncLocalStorage<{ actor: Actor; causationId?: string; correlationId?: string }>();
export const withEventActor = <T>(actor: Actor, work: () => Promise<T>, linkage?: { causationId: string; correlationId: string }) => context.run({ actor, ...linkage }, work);

/** Await inside the business transaction. Realtime notifications remain hints; the outbox is authoritative. */
export async function emitDurable(db: Database, event: RealtimeEvent) {
  const id = event.eventId ?? randomUUID();
  const occurredAt = new Date(event.serverTime ?? Date.now());
  const scope = context.getStore();
  const enriched = { ...event, eventId: id, serverTime: occurredAt.toISOString() } as RealtimeEvent;
  await db.insert(webhookEvents).values({ id, eventType: event.type,
    projectId: "projectId" in event ? event.projectId : null,
    actorId: scope?.actor.id, actorType: scope?.actor.type, causationId: scope?.causationId,
    correlationId: scope?.correlationId ?? id, event: JSON.parse(serializeRealtimeEvent(enriched)), occurredAt }).onConflictDoNothing();
  emit(enriched);
}
