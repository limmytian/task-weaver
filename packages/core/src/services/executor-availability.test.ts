import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecutorObservation } from "@task-weaver/contracts";
import { availabilityRecheckAt, effectiveAvailability } from "./executor-availability";

const now = new Date("2026-10-08T12:00:00Z");
const blocked: ExecutorObservation = {
  eventId: randomUUID(), tool: "codex", profileId: "fixture", poolId: null,
  toolVersion: null, authenticationMode: "subscription", state: "cooling_down",
  failure: "quota_exhausted", source: "status_query", confidence: "high",
  observedAt: now.toISOString(), staleAt: new Date(now.getTime() + 60_000).toISOString(),
  resetAt: null, retryAfterSeconds: null, reason: "Fixture quota interruption", windows: [],
};

test("recheck scheduling honors reset hints, capped backoff, jitter and action requirements", () => {
  assert.equal(availabilityRecheckAt(blocked, 0, now, () => 0)?.getTime(), now.getTime() + 30_000);
  assert.equal(availabilityRecheckAt(blocked, 100, now, () => 0)?.getTime(), now.getTime() + 900_000);
  assert.equal(availabilityRecheckAt({ ...blocked, retryAfterSeconds: 120 }, 0, now, () => 0.5)?.getTime(), now.getTime() + 122_500);
  const resetAt = new Date(now.getTime() + 3600_000).toISOString();
  assert.equal(availabilityRecheckAt({ ...blocked, resetAt }, 100, now, () => 0)?.toISOString(), resetAt);
  assert.equal(availabilityRecheckAt({ ...blocked, state: "action_required" }, 0, now), null);
});

test("a stale query loses allowance certainty without mutating persisted interruption evidence", () => {
  assert.equal(effectiveAvailability(blocked, now.getTime()).state, "cooling_down");
  assert.equal(effectiveAvailability(blocked, now.getTime() + 60_000).state, "unknown");
  assert.equal(blocked.state, "cooling_down");
});
