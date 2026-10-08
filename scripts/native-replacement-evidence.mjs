import assert from "node:assert/strict";

export function assertReplacementEvidence(evidence, image) {
  const receipts = evidence.images ?? [evidence];
  const matches = receipts.filter(receipt => receipt.imageId === image.imageId && receipt.platform === image.platform);
  assert.equal(matches.length, 1, "Exactly one replacement receipt must match the image and platform");
  const receipt = matches[0];
  assert.equal(receipt.passed, true);
  assert.equal(receipt.markerObserved, true);
  assert.equal(receipt.missingLibraryControlFailed, true);
  return receipt;
}
