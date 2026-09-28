import assert from "node:assert/strict";
import test from "node:test";
import {
  isDaemonStale,
  isLeaseAtRisk,
  normalizeWorkerSlots,
  queueItemsForView,
  summarizeRoleCapacity,
} from "./control-plane";

test("rapid worker updates keep the newest state for each slot and preserve idle capacity", () => {
  const slots = normalizeWorkerSlots([
    { index: 0, status: "claiming", requirementId: "requirement-old" },
    { index: 0, status: "running", requirementId: "requirement-new" },
    { index: 2, status: "failed", requirementId: "requirement-failed" },
  ], 4);

  assert.equal(slots.length, 4);
  assert.equal(slots[0]?.status, "running");
  assert.equal(slots[0]?.requirementId, "requirement-new");
  assert.equal(slots[1]?.status, "idle");
  assert.equal(slots[2]?.status, "failed");
  assert.equal(slots[3]?.status, "idle");
});

test("role capacity stays isolated when one actor runs colliding slot indexes", () => {
  const capacity = summarizeRoleCapacity([
    { role: "executor", workerCapacity: 2, workerStates: [{ index: 0, status: "running", requirementId: "req-1" }] },
    { role: "reviewer", workerCapacity: 1, workerStates: [{ index: 0, status: "idle" }] },
    { role: "merger", workerCapacity: 1, workerStates: [{ index: 0, status: "running", requirementId: "req-2" }] },
  ]);

  assert.deepEqual(capacity.map(({ role, configured, active, idle }) => ({ role, configured, active, idle })), [
    { role: "executor", configured: 2, active: 1, idle: 1 },
    { role: "reviewer", configured: 1, active: 0, idle: 1 },
    { role: "merger", configured: 1, active: 1, idle: 0 },
  ]);
});

test("stale daemon and lease state change exactly at their safety boundaries", () => {
  const now = Date.parse("2026-07-24T08:01:00.000Z");
  assert.equal(isDaemonStale("2026-07-24T08:00:00.000Z", now), false);
  assert.equal(isDaemonStale("2026-07-24T07:59:59.999Z", now), true);
  assert.equal(isLeaseAtRisk({ leaseHealthy: true, claim: { expiresAt: "2026-07-24T08:01:00.001Z" } }, now), false);
  assert.equal(isLeaseAtRisk({ leaseHealthy: false }, now), true);
  assert.equal(isLeaseAtRisk({ leaseHealthy: true, claim: { expiresAt: "2026-07-24T08:00:59.999Z" } }, now), true);
});

test("empty and large queues remain correctly partitioned", () => {
  assert.deepEqual(queueItemsForView([], "blocked"), []);
  const items = Array.from({ length: 600 }, (_, index) => ({
    id: index,
    role: index % 3 === 0 ? "executor" as const : index % 3 === 1 ? "reviewer" as const : "merger" as const,
    state: index % 5 === 0 ? "blocked" as const : "runnable" as const,
  }));

  assert.equal(queueItemsForView(items, "blocked").length, 120);
  assert.equal(queueItemsForView(items, "executor").every((item) =>
    item.role === "executor" && item.state === "runnable",
  ), true);
});

