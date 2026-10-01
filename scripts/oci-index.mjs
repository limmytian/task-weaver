import assert from "node:assert/strict";
import { RELEASE_PLATFORMS } from "./release-platforms.mjs";

export function verifyOciIndex(index, expected) {
  assert.ok(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType), "A multi-platform index is required");
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.manifests.length, RELEASE_PLATFORMS.length, "Only the reviewed platforms may enter the index");
  assert.deepEqual(index.manifests.map(entry => `${entry.platform?.os}/${entry.platform?.architecture}`).sort(), [...RELEASE_PLATFORMS].sort(), "Missing, duplicate or unexpected platform");
  for (const entry of index.manifests) {
    const platform = `${entry.platform.os}/${entry.platform.architecture}`;
    assert.equal(entry.digest, expected[platform], "Index child differs from the reviewed platform image");
    assert.match(entry.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
    assert.ok(!entry.platform.variant || (platform === "linux/arm64" && entry.platform.variant === "v8"), "Unexpected architecture variant");
  }
  return index;
}
