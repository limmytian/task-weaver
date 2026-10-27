import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExecutionRecoveryView } from "@task-weaver/contracts";
import { RecoveryObservationView } from "../components/recovery-observation-view";

const time = "2026-01-01T00:00:00.000Z";
const view: ExecutionRecoveryView = {
  observedAt: time, planRevision: 4, evidenceNeedsReview: false,
  lane: { state: "not_held", runId: null, expiresAt: null, executionAuthority: "not_established", fleetCapacity: null, daemonHealth: "not_observed" },
  retry: { used: 2, remaining: 0, maximum: 2, automaticRetrySafe: false }, controls: [],
  actions: { revalidate: { allowed: false, blockedReason: "evidence_current" }, recover: { allowed: false, blockedReason: "no_control", controlId: null, expectedControlUpdatedAt: null } },
};
test("recovery view renders honest missing/capacity/wait states and on-demand identifiers", () => {
  const empty = renderToStaticMarkup(React.createElement(RecoveryObservationView, { view }));
  assert.match(empty, /No recovery control recorded/);
  assert.match(empty, /Unknown\. This view does not observe node health or fleet capacity/);
  assert.match(empty, /a free fleet slot is not established/);
  const blocked: ExecutionRecoveryView = { ...view, controls: [{ id: "control-fixture", runId: "old-run-fixture", daemonId: "daemon-fixture", revision: 4, phase: "blocked", reason: "Required input is unavailable", deadline: time, deadlinePassed: true, nodeId: "recorded-node", preservedState: "dirty", stopObservation: "not_established", observations: [{ kind: "created", at: time }, { kind: "latest_phase", at: time }], updatedAt: time }] };
  const html = renderToStaticMarkup(React.createElement(RecoveryObservationView, { view: blocked }));
  assert.match(html, /Waiting for executable inputs/);
  assert.match(html, /Intermediate phase timestamps were not recorded/);
  assert.match(html, /Termination is not established/);
  assert.match(html, /elapsed; inspect preserved work/);
  assert.match(html, /<details[^>]*><summary[^>]*>Technical details/);
  assert.match(html, /Local metadata does not reconstruct files/);
});
