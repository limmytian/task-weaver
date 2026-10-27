import assert from "node:assert/strict";
import test from "node:test";
import { capabilityOperationEvidence } from "./capability-evidence";

const id = "00000000-0000-4000-8000-000000000001";
const sha256 = "a".repeat(64);
const privateText = "Private content and tool arguments must stay outside audit metadata.";

test("selected capability evidence keeps exact references without bodies or arbitrary metadata", () => {
  const evidence = capabilityOperationEvidence("readPackageTextFile", { packageId: id }, {
    packageVersion: { packageId: id, version: "1.2.3" }, file: { sha256, storageKey: privateText }, content: privateText,
  });
  assert.equal(evidence.assetId, id);
  assert.equal(evidence.assetVersion, "1.2.3");
  assert.equal(evidence.assetSha256, sha256);
  assert.equal(evidence.assetHashKind, "file");
  assert.equal(evidence.evidenceSource, "api");
  assert.ok(!JSON.stringify(evidence).includes(privateText));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 1024);
  assert.deepEqual(capabilityOperationEvidence("getSkill", {}, { id: privateText, content: privateText }), {});
});

test("empty discovery, reported use and verified reads remain distinct", () => {
  assert.equal(capabilityOperationEvidence("searchContext", {}, []).capabilityOutcome, "empty");
  const report = capabilityOperationEvidence("addTaskComment", id, { id, content: privateText });
  assert.equal(report.evidenceSource, "agent_report");
  assert.equal(report.assetId, undefined);
  const read = capabilityOperationEvidence("getMemory", id, { id, version: 7, content: privateText, sourceFreshness: "changed" });
  assert.equal(read.assetVersion, "7");
  assert.equal(read.sourceFreshness, "changed");
  assert.ok(!JSON.stringify(read).includes(privateText));
  assert.equal(capabilityOperationEvidence("searchContext", {}, {}).capabilityOutcome, undefined);
});

test("invocation evidence identifies the inspected schema or resolved graph without arguments", () => {
  const call = capabilityOperationEvidence("callTool", { toolId: id, expectedSchemaHash: sha256, arguments: privateText }, { isError: true, id: "00000000-0000-4000-8000-000000000002", schemaHash: "b".repeat(64), version: "forged" });
  assert.equal(call.assetHashKind, "tool_schema");
  assert.equal(call.assetId, id);
  assert.equal(call.assetSha256, sha256);
  assert.equal(call.assetVersion, undefined);
  assert.equal(call.capabilityOutcome, "upstream_error");
  assert.ok(!JSON.stringify(call).includes(privateText));
  const run = capabilityOperationEvidence("tw_skills_run", { packageId: id, version: "2.0.0", manifestHash: sha256, input: privateText }, { manifestHash: sha256, status: "failed", stderr: privateText });
  assert.equal(run.assetHashKind, "manifest_graph");
  assert.equal(run.executionStatus, "failed");
  assert.ok(!JSON.stringify(run).includes(privateText));
});
