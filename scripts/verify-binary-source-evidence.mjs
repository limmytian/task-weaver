#!/usr/bin/env node
import { rustTargets, sourcePlatform } from "./release-platforms.mjs";

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest, imageEvidence, replacementEvidence] = process.argv.slice(2);
if (!manifest || !imageEvidence || !replacementEvidence) {
  throw new Error("Usage: node scripts/verify-binary-source-evidence.mjs <verified-source-lock.json> <image-evidence-directory> <replacement-verification.json>");
}
const root = resolve("release-artifacts/binary-sources");
const lockBytes = readFileSync(resolve(manifest));
const lock = JSON.parse(lockBytes);
const inventory = JSON.parse(readFileSync(resolve(imageEvidence, "inventory.json")));
const licenses = JSON.parse(readFileSync(resolve(root, "license-extraction.json")));
const replacement = JSON.parse(readFileSync(resolve(replacementEvidence)));
const noticeCases = JSON.parse(readFileSync(resolve(root, "notice-case-resolutions.json")));
assert.equal(noticeCases.sourceLockSha256, hash(lockBytes), "Notice handling is for a different source lock");
assert.equal(noticeCases.noticeBundleSha256, hash(readFileSync(resolve(root, "runtime-source-NOTICES.txt"))));
assert.deepEqual(noticeCases.unresolvedTechnicalCases, []);
assert.deepEqual(noticeCases.resolutions.map((entry) => entry.component).sort(), [...licenses.componentsWithoutArchiveLicenseText].sort());
assert.equal(lock.schemaVersion, 1);
assert.equal(licenses.failures.length, 0, "License extraction must succeed");
assert.equal(new Set(lock.files.map((file) => file.path)).size, lock.files.length, "Duplicate source paths");
assert.equal(new Set(lock.components.map((component) => component.id)).size, lock.components.length, "Duplicate source components");
for (const file of lock.files) assertChecksums(file, resolve(root, safePath(file.path)));
for (const text of licenses.evidence) {
  assert.equal(hash(readFileSync(resolve(root, safePath(text.path)))), text.sha256, "Extracted license text changed");
}
for (const image of inventory.inventory) {
  assert.ok(lock.images.some((entry) => entry.imageId === image.imageId && entry.platform === image.platform), "Image identity is not covered by this source lock");
  const report = JSON.parse(readFileSync(resolve(imageEvidence, safePath(image.report))));
  assert.equal(report.imageId, image.imageId);
  assert.equal(report.runtimeNoticeVerified, true, "Complete pinned runtime notices are not delivered in this image");
  assert.equal(report.runtimeNoticesSha256, noticeCases.noticeBundleSha256);
  for (const native of report.nativeToolchains ?? []) {
    assert.ok(lock.rustRuntimeEvidence.libraries.some((entry) => entry.sha256 === native.sha256), "Native object changed after source correspondence review");
    assert.ok(native.rustCommits.length > 0, "Native compiler-runtime identity is missing");
    for (const commit of native.rustCommits) {
      assert.ok(lock.components.some((entry) => entry.id === "rust-standard-library" && entry.commit === commit), "Rust standard-library source mapping is missing");
    }
  }
  assert.ok(lock.components.some((entry) => entry.family === "runtime" && entry.version === report.runtime.version));
  for (const pkg of report.osSourcePackages) {
    assert.ok(lock.components.some((entry) => entry.family === "alpine" && entry.origin === pkg.o && entry.commit === pkg.c &&
      entry.packages.some((item) => item.name === pkg.P && item.version === pkg.V)), "OS source mapping is incomplete");
  }
  for (const native of report.nativeLibraries) {
    assert.ok(lock.components.some((entry) => entry.family === "native-recipe" && entry.version === native.version));
    for (const [name, version] of Object.entries(native.libraries)) {
      // The Sharp addon has a separate source archive; the remaining versions
      // come from the exact native recipe's source download declarations.
      if (name === "sharp") continue;
      assert.ok(lock.components.some((entry) => entry.id === `native-${name}` && entry.version === version), `Native source mapping is incomplete: ${name}`);
    }
    assert.equal(replacement.imageId, image.imageId, "Replacement evidence is for a different image");
    assert.equal(replacement.platform, image.platform);
  }
}
assert.equal(lock.rustVendoring.postEditLockVerified, true);
const rust = JSON.parse(readFileSync(resolve(root, safePath(lock.rustVendoring.verification))));
assert.equal(rust.passed, true);
assert.equal(rust.newRegistryPackages, 0);
assert.equal(hash(readFileSync(resolve(root, "librsvg-post-edit-Cargo.lock"))), rust.postEditCargoLockSha256);
assert.equal(rust.postEditCargoLockSha256, lock.rustVendoring.postEditCargoLockSha256);
if (lock.components.some((entry) => entry.id === "rust-standard-library")) {
  const dependencyLock = lock.rustRuntimeEvidence.registryDependencyLock;
  assert.ok(dependencyLock, "Standard-library registry source coverage is missing");
  const text = readFileSync(resolve(root, safePath(dependencyLock.path)), "utf8");
  assert.equal(hash(text), dependencyLock.sha256);
  for (const block of text.split("[[package]]").slice(1)) {
    if (!/^source = /m.test(block)) continue;
    const name = block.match(/^name = "([^"]+)"/m)[1];
    const version = block.match(/^version = "([^"]+)"/m)[1];
    const checksum = block.match(/^checksum = "([a-f0-9]{64})"/m)[1];
    assert.ok(lock.files.some((entry) => entry.path === `rust-crates/${name}-${version}.crate` && entry.sha256 === checksum), "Standard-library crate source mapping is incomplete");
  }
}
if (lock.files.some((file) => file.path.startsWith("rust-crates/"))) {
  const coverage = JSON.parse(readFileSync(resolve(root, safePath(lock.rustVendoring.linuxSourceCoverage))));
  assert.equal(coverage.passed, true);
  const targets = rustTargets(sourcePlatform(lock));
  assert.deepEqual(coverage.trees.filter(tree => tree.package === "librsvg-c").map(tree => tree.target).sort(), [...targets].sort(), "Native source trees do not cover the image platform");
  if (lock.rustRuntimeEvidence?.registryDependencyLock) assert.deepEqual(coverage.trees.filter(tree => tree.package === "std").map(tree => tree.target).sort(), [...targets].sort());
  assert.equal(coverage.sourceOnlyVendorReplayPassed, true);
  assert.equal(coverage.postEditCargoLockSha256, rust.postEditCargoLockSha256);
  for (const tree of coverage.trees) {
    const filename = `${tree.package === "std" ? "std-" : ""}${tree.target}-source-tree.txt`;
    assert.equal(hash(readFileSync(resolve(root, safePath(filename)))), tree.treeSha256);
  }
  if (lock.rustRuntimeEvidence?.registryDependencyLock) assert.equal(coverage.trees.filter((tree) => tree.package === "std").length, 2);
  const delivery = JSON.parse(readFileSync(resolve(root, "rust-source-delivery.json")));
  assert.equal(delivery.linuxTreeReplayPassed, true);
  if (lock.rustRuntimeEvidence?.registryDependencyLock) assert.ok(delivery.files.some((file) => file.path.startsWith("rust-standard-library/source/library/")), "Sanitized standard-library source delivery is missing");
  for (const file of delivery.files) {
    const bytes = readFileSync(resolve(root, safePath(file.sourcePath)));
    assert.equal(hash(bytes), file.sha256);
    const magic = bytes.subarray(0, 4).toString("hex");
    assert.ok(!["7f454c46", "0061736d", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "4243c0de"].includes(magic) && bytes.subarray(0, 8).toString() !== "!<arch>\n", "Compiled payload found in source-only delivery");
  }
}
assert.equal(replacement.passed, true);
assert.equal(replacement.markerObserved, true);
assert.equal(replacement.missingLibraryControlFailed, true);
if (inventory.inventory.some((image) => {
  const report = JSON.parse(readFileSync(resolve(imageEvidence, safePath(image.report))));
  return report.nativeLibraries.length > 0;
})) {
  const directory = resolve(replacementEvidence, "..");
  const filename = replacement.libraryPath.split("/").at(-1);
  assert.match(filename, /^libvips-cpp\.so\.\d+(?:\.\d+)*$/);
  assert.equal(hash(readFileSync(resolve(directory, "original.so"))), replacement.originalSha256);
  assert.equal(hash(readFileSync(resolve(directory, "replacement", filename))), replacement.replacementSha256);
  assert.equal(hash(readFileSync(resolve(import.meta.dirname, "fixtures/libvips-replacement.c"))), replacement.fixtureSha256);
}
const report = { schemaVersion: 1, sourceLockSha256: hash(lockBytes), images: lock.images,
  sourceFiles: lock.files.length, components: lock.components.length, preservedLicenseFiles: licenses.evidence.length,
  postEditRustDependencies: rust.postEditRegistryPackages, sourceIntegrityPassed: true, replacementPassed: true,
  explicitlyHandledArchiveNotices: noticeCases.resolutions, unresolvedArchiveNotices: [],
  distributionApproved: false,
  remaining: ["Rerun image-bound vulnerability, layer and deployment checks for the exact candidate images.",
    "Obtain the owner's publication checkpoint; evidence integrity does not approve distribution."] };
writeFileSync(resolve(root, "binary-source-verification.json"), json(report));
console.log(json(report));
