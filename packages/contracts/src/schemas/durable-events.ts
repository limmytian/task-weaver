import { z } from "zod";

// Decimal strings preserve the full PostgreSQL bigint range across JSON clients.
export const eventCursorSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= 9223372036854775807n, "Cursor exceeds bigint range");
const positiveCursor = eventCursorSchema.refine(value => value !== "0", "Event sequence must be positive");
const object = z.record(z.string(), z.unknown());
export const durableEventSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), sequence: positiveCursor,
  type: z.string().min(1), version: z.number().int().min(1).max(2147483647),
  scope: object, payload: object, occurredAt: z.string().datetime({ offset: true }), recordedAt: z.string().datetime({ offset: true }),
}).strict();
export const eventConsumerSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), name: z.string().min(1),
  acknowledgedSequence: eventCursorSchema, createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
// A cursor below the floor has lost history; clients must explicitly resynchronize.
export const eventCursorStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), cursor: eventCursorSchema, retentionFloor: eventCursorSchema }).strict().refine(v => BigInt(v.cursor) >= BigInt(v.retentionFloor)),
  z.object({ status: z.literal("expired"), cursor: eventCursorSchema, retentionFloor: eventCursorSchema }).strict().refine(v => BigInt(v.cursor) < BigInt(v.retentionFloor)),
]);
export type DurableEvent = z.infer<typeof durableEventSchema>;
export type EventConsumer = z.infer<typeof eventConsumerSchema>;
export type EventCursorStatus = z.infer<typeof eventCursorStatusSchema>;
