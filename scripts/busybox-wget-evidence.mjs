import assert from "node:assert/strict";

export function assertBusyboxWgetEvidence(report, imageId, platform) {
  assert.equal(report?.passed, true, "BusyBox wget verification is required");
  assert.equal(report.imageId, imageId, "BusyBox wget verification image mismatch");
  assert.equal(report.platform, platform, "BusyBox wget verification platform mismatch");
}
