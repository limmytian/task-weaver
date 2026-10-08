import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";

export function listSavedImageLayer(archive, layer, temporaryFile) {
  assert.match(layer, /^(?:[a-f0-9]{64}\/layer\.tar|blobs\/sha256\/[a-f0-9]{64})$/);
  const fd = openSync(temporaryFile, "w", 0o600);
  try {
    // Write payload bytes directly to disk; large OCI layers must not fill a subprocess buffer.
    const extract = spawnSync("tar", ["-xOf", archive, "--", layer], { stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
    assert.equal(extract.status, 0, `Unable to read saved image layer: ${extract.error?.message ?? extract.stderr}`);
    const listing = spawnSync("tar", ["-tf", temporaryFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(listing.status, 0, `Unable to list saved image layer: ${listing.error?.message ?? listing.stderr}`);
    return listing.stdout.split("\n");
  } finally {
    closeSync(fd);
    rmSync(temporaryFile, { force: true });
  }
}
