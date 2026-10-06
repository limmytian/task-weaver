import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { realtimeEventSchema, type RealtimeEvent } from "@task-weaver/contracts/events";

export { realtimeEventSchema, type RealtimeEvent } from "@task-weaver/contracts/events";
export { acceptRealtimeSequence } from "./sequence";

const CHANNEL = "task_weaver_events";

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
let sql: postgres.Sql | null = null;
let initialized = false;
let initialization: Promise<void> | null = null;
let sequence = 0;

/**
 * Initialize the realtime system with a PostgreSQL connection.
 * Uses PG LISTEN/NOTIFY for cross-process event delivery.
 * Must be called before subscribe() or emit() to enable PG transport.
 */
export async function initRealtime(connectionString: string): Promise<void> {
  if (initialized) return;
  if (initialization) return initialization;
  initialization = initializeTransport(connectionString).catch(async error => {
    if (sql) await sql.end({ timeout: 1 });
    sql = null;
    throw error;
  }).finally(() => { initialization = null; });
  return initialization;
}

async function initializeTransport(connectionString: string): Promise<void> {
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
  await initialization?.catch(() => {});
  if (sql) {
    await sql.end();
    sql = null;
  }
  initialized = false;
  sequence = 0;
  listeners.clear();
}
