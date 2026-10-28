#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { json, safePath } from "./binary-source-lib.mjs";

const [manifest, evidence] = process.argv.slice(2);
if (!manifest || !evidence) throw new Error("Usage: node scripts/rebind-binary-source-images.mjs <source-lock.json> <image-evidence-directory>");
const lock = JSON.parse(readFileSync(resolve(manifest)));
const inventory = JSON.parse(readFileSync(resolve(evidence, "inventory.json")));
assert.equal(inventory.inventory.length, lock.images.length);
for (const image of inventory.inventory) {
  const report = JSON.parse(readFileSync(resolve(evidence, safePath(image.report))));
  assert.equal(report.imageId, image.imageId);
  assert.equal(report.runtimeNoticeVerified, true);
  assert.ok(lock.components.some((entry) => entry.family === "runtime" && entry.version === report.runtime.version));
  if (report.osSourcePackages.some((pkg) => pkg.P === "busybox")) {
    const integrity = report.busyboxPackageIntegrity;
    assert.match(integrity?.packageChecksum ?? "", /^Q1[A-Za-z0-9+/]{27}=$/, "BusyBox package checksum missing");
    assert.equal(integrity.actualPackageChecksum, integrity.packageChecksum, "BusyBox differs from installed package; modified source and build inputs require separate review");
    assert.match(integrity.sha256 ?? "", /^[a-f0-9]{64}$/);
  }
  for (const pkg of report.osSourcePackages) {
    assert.ok(lock.components.some((entry) => entry.family === "alpine" && entry.origin === pkg.o && entry.commit === pkg.c &&
      entry.packages.some((item) => item.name === pkg.P && item.version === pkg.V)), "OS source baseline drift");
  }
  for (const native of report.nativeLibraries) {
    assert.ok(lock.components.some((entry) => entry.family === "native-recipe" && entry.version === native.version));
    for (const [name, version] of Object.entries(native.libraries)) {
      if (name === "sharp") {
        assert.ok(lock.components.some((entry) => entry.id === "sharp-addon" && entry.version === version));
      } else assert.ok(lock.components.some((entry) => entry.id === `native-${name}` && entry.version === version), `Native source baseline drift: ${name}`);
    }
  }
  for (const native of report.nativeToolchains ?? []) {
    assert.ok(lock.rustRuntimeEvidence.libraries.some((entry) => entry.sha256 === native.sha256), "Native shared object changed; review source correspondence again");
    for (const commit of native.rustCommits) assert.ok(lock.components.some((entry) => entry.id === "rust-standard-library" && entry.commit === commit));
  }
}
lock.images = inventory.inventory.map(({ image, imageId, platform }) => ({ image, imageId, platform }));
writeFileSync(resolve(manifest), json(lock));
console.log("Rebound source lock to final images after exact OS/native/runtime baseline checks; rerun all image-bound evidence verification.");
