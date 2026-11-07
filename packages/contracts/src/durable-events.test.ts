import assert from "node:assert/strict";
import test from "node:test";
import { durableEventSchema, eventCursorSchema, eventCursorStatusSchema } from "./schemas/durable-events";

const event = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", sequence: "1", type: "future.example", version: 2, scope: { resource: "example" }, payload: { arbitrary: true }, occurredAt: "2026-01-01T00:00:00Z", recordedAt: "2026-01-01T00:00:01Z" };
test("generic events preserve cursor precision and validate their envelope", () => {
  assert.equal(durableEventSchema.parse(event).type, "future.example");
  assert.equal(eventCursorSchema.safeParse("9223372036854775807").success, true);
  for (const cursor of ["-1", "01", "9223372036854775808", 1]) assert.equal(eventCursorSchema.safeParse(cursor).success, false);
  assert.equal(durableEventSchema.safeParse({ ...event, sequence: "0" }).success, false);
  assert.equal(durableEventSchema.safeParse({ ...event, version: 0 }).success, false);
  assert.equal(durableEventSchema.safeParse({ ...event, scope: [] }).success, false);
});
test("cursor expiry is relative to the inclusive retention floor", () => {
  assert.equal(eventCursorStatusSchema.safeParse({ status: "valid", cursor: "4", retentionFloor: "4" }).success, true);
  assert.equal(eventCursorStatusSchema.safeParse({ status: "expired", cursor: "3", retentionFloor: "4" }).success, true);
  assert.equal(eventCursorStatusSchema.safeParse({ status: "valid", cursor: "3", retentionFloor: "4" }).success, false);
  assert.equal(eventCursorStatusSchema.safeParse({ status: "expired", cursor: "4", retentionFloor: "4" }).success, false);
});
