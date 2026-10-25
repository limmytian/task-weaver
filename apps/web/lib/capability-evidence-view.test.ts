import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityEvidenceView } from "@task-weaver/contracts";
import { CapabilityEvidenceViewContent } from "../components/capability-evidence-panel";

test("evidence UI separates visible references, progress reports and unknown usefulness/cost", () => {
  const data: CapabilityEvidenceView = {
    schemaVersion: 1, projectId: "project-fixture", since: "2026-01-01T00:00:00Z", observedAt: "2026-01-02T00:00:00Z", grouping: "unique_visible_references", totalVisibleReferences: 0, reportedProgressReferences: 1,
    coverage: { complete: false, discovery: "unknown", taskUsefulness: "not_measured", modelCost: null, contextTokens: null }, summary: [], items: [],
  };
  const empty = renderToStaticMarkup(React.createElement(CapabilityEvidenceViewContent, { data }));
  assert.match(empty, /Progress reports do not verify capability use/);
  assert.match(empty, /zero visible count does not prove no use/);
  assert.match(empty, /not API-call totals or a measure of task quality/);
  assert.match(empty, /context tokens and model cost remain unknown/);
  const content = renderToStaticMarkup(React.createElement(CapabilityEvidenceViewContent, { data: { ...data, totalVisibleReferences: 1, items: [{ id: "observation", kind: "memory", assetId: "memory", action: "read", outcome: "observed", runId: null, attribution: "credential", recordedAt: data.observedAt, assetVersion: "1", assetSha256: null, assetHashKind: null, sourceFreshness: "changed", durationMs: null }] } }));
  assert.match(content, /no daemon run is inferred/);
  assert.match(content, /task outcome unverified/);
  assert.match(content, /source freshness at observation: changed/);
  assert.match(content, /Recheck before reuse/);
  assert.match(content, /API duration: Unknown/);
  assert.match(content, /More calls or saved memories do not establish better results/);
});
