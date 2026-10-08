import assert from "node:assert/strict";
import test from "node:test";
import { assertReplacementEvidence } from "./native-replacement-evidence.mjs";

const receipt = (imageId, platform = "linux/amd64") => ({ imageId, platform, passed: true, markerObserved: true, missingLibraryControlFailed: true });
test("paired native evidence requires each image's own successful replacement controls", () => {
  const api = receipt("api");
  const web = receipt("web");
  const evidence = { schemaVersion: 2, images: [api, web] };
  assert.equal(assertReplacementEvidence(evidence, api), api);
  assert.equal(assertReplacementEvidence(evidence, web), web);
  assert.throws(() => assertReplacementEvidence(web, api));
  assert.throws(() => assertReplacementEvidence(evidence, receipt("api", "linux/arm64")));
  assert.throws(() => assertReplacementEvidence({ images: [api, api] }, api));
  for (const field of ["passed", "markerObserved", "missingLibraryControlFailed"]) {
    assert.throws(() => assertReplacementEvidence({ images: [{ ...api, [field]: false }, web] }, api));
  }
});
