import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecoveryView } from "@task-weaver/contracts";
import { recoveryDecisionKey, recoveryReviewComplete } from "./recovery-decision";

const view = {
  planRevision: 3, evidenceNeedsReview: true, observedAt: "2026-01-01T00:00:00Z",
  controls: [{ id: "control", updatedAt: "2026-01-01T00:00:00Z", phase: "manual" }],
  actions: { revalidate: { allowed: true, blockedReason: null }, recover: { allowed: true, blockedReason: null } },
} as unknown as ExecutionRecoveryView;

test("operator confirmation survives unchanged polling but is invalidated by plan, phase and permission changes", () => {
  const key = recoveryDecisionKey(view);
  assert.equal(recoveryDecisionKey({ ...view, observedAt: "2026-01-01T00:00:15Z" }), key);
  assert.notEqual(recoveryDecisionKey({ ...view, planRevision: 4 }), key);
  assert.notEqual(recoveryDecisionKey({ ...view, controls: [{ ...view.controls[0]!, phase: "stopping" }] }), key);
  assert.notEqual(recoveryDecisionKey({ ...view, controls: [{ ...view.controls[0]!, updatedAt: "2026-01-01T00:00:01Z" }] }), key);
  assert.notEqual(recoveryDecisionKey({ ...view, actions: { ...view.actions, recover: { ...view.actions.recover, allowed: false, blockedReason: "management_permission_required" } } }), key);
});

test("manual recovery requires all outcome/input/provenance/termination reviews and a bounded reason", () => {
  assert.equal(recoveryReviewComplete("", [true, true, true, true]), false);
  assert.equal(recoveryReviewComplete("verified", [true, true, false, true]), false);
  assert.equal(recoveryReviewComplete("verified", [true, true, true]), false);
  assert.equal(recoveryReviewComplete("x".repeat(4001), [true, true, true, true]), false);
  assert.equal(recoveryReviewComplete("Inspected outcomes and durable inputs", [true, true, true, true]), true);
});
