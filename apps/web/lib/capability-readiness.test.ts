import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectCapabilityReadiness } from "@task-weaver/contracts";
import { CapabilityReadinessView } from "../components/capability-readiness-panel";

test("readiness UI distinguishes empty inventory, missing invocation and unprobed candidates", () => {
  const data: ProjectCapabilityReadiness = {
    schemaVersion: 1, projectId: "project-fixture", observedAt: "2026-01-01T00:00:00Z", scope: "selected_project_only", readPermission: "granted", invokePermission: "missing", runtimeSource: "api", runtimeObservation: "api_profile_state",
    inventory: ["skill", "skill_package", "memory", "mcp_tool"].map(kind => ({ kind: kind as ProjectCapabilityReadiness["inventory"][number]["kind"], access: "granted" as const, registered: 0, contentCandidates: 0, inspectionRequired: true })),
    hostedExecution: { state: "unavailable", reason: "not_configured", remediation: "Inspect approved API runtime profiles" }, checklist: ["Inspect selected exact content before use"],
  };
  const empty = renderToStaticMarkup(React.createElement(CapabilityReadinessView, { data }));
  assert.match(empty, /No registered capability content/);
  assert.match(empty, /invocation permission: missing/);
  assert.match(empty, /not_configured/);
  assert.match(empty, /Candidate metadata does not prove readable storage/);
  const ready = renderToStaticMarkup(React.createElement(CapabilityReadinessView, { data: { ...data, hostedExecution: { state: "available", executionMode: "isolated" }, inventory: data.inventory.map(item => ({ ...item, access: "granted" as const, registered: 1, contentCandidates: 1 })) } }));
  assert.doesNotMatch(ready, /No registered capability content/);
  assert.match(ready, /exact asset dependencies, image\/graph pins and approvals still require inspection/);
});
