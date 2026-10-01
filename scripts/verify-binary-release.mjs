#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash, json, safePath } from "./binary-source-lib.mjs";

import { releasePlatform } from "./release-platforms.mjs";

const [deploymentPath] = process.argv.slice(2);
if (!deploymentPath) throw new Error("Usage: node scripts/verify-binary-release.mjs <disposable-deployment-verification.json>");
const root = resolve("release-artifacts");
const read = (path) => JSON.parse(readFileSync(resolve(root, path)));
const licenses = read("binary-licenses/inventory.json");
const scans = read("images/inventory.json");
const source = read("binary-sources/binary-source-verification.json");
const sidecar = read("binary-sources/source-package.json");
const replacement = read("native-replacement/verification.json");
const deployment = JSON.parse(readFileSync(resolve(deploymentPath)));
assert.equal(licenses.inventory.length, 2);
assert.equal(scans.scope, "first-party-release");
assert.equal(source.sourceIntegrityPassed, true);
assert.deepEqual(source.unresolvedArchiveNotices, []);
assert.equal(sidecar.sourceLockSha256, source.sourceLockSha256);
assert.equal(hash(readFileSync(resolve(root, "binary-sources/source-lock.json"))), source.sourceLockSha256);
assert.equal(sidecar.sourceOnlyRustVendor, true);
assert.equal(deployment.passed, true);
const digest = createHash("sha256");
for await (const chunk of createReadStream(resolve(root, "binary-sources", safePath(sidecar.archive)))) digest.update(chunk);
assert.equal(digest.digest("hex"), sidecar.sha256);
const images = [];
for (const image of licenses.inventory) {
  releasePlatform(image.platform);
  assert.ok(licenses.inventory.every(entry => entry.platform === image.platform), "A candidate must not mix platform evidence");
  const report = read(`binary-licenses/${safePath(image.report)}`);
  assert.equal(report.runtimeNoticeVerified, true);
  const scan = scans.inventory.find((entry) => entry.imageId === image.imageId && entry.platform === image.platform);
  assert.ok(scan?.passed, "Missing or failed image-bound vulnerability gate");
  assert.ok(!Object.entries(scan.counts).some(([severity, count]) => /^(?:high|critical)$/i.test(severity) && count > 0));
  assert.equal(hash(readFileSync(resolve(root, "images", safePath(scan.sbom)))), scan.sha256);
  const layers = read(`runtime-layers/${image.imageId.slice(7)}/verification.json`);
  assert.equal(layers.imageId, image.imageId);
  assert.equal(layers.passed, true);
  assert.deepEqual(layers.forbidden, []);
  assert.ok(source.images.some((entry) => entry.imageId === image.imageId && entry.platform === image.platform));
  assert.ok(deployment.imageIds.some((entry) => entry.imageId === image.imageId && entry.platform === image.platform));
  if (image.nativeLibraryPackages) {
    assert.equal(replacement.imageId, image.imageId);
    assert.equal(replacement.platform, image.platform);
    assert.equal(replacement.passed, true);
    assert.equal(replacement.markerObserved, true);
    assert.equal(replacement.missingLibraryControlFailed, true);
  }
  images.push({ image: image.image, imageId: image.imageId, platform: image.platform, deliveredNoticeSha256: report.runtimeNoticesSha256,
    sbomSha256: scan.sha256, vulnerabilities: scan.counts, deliveredLayers: layers.layers });
}
const result = { schemaVersion: 1, images, correspondingSource: sidecar, sourceIntegrityPassed: true,
  noticeHandlingPassed: true, deliveredNoticeBaselinePassed: true, deliveredLayerGatePassed: true,
  imageSbomAndVulnerabilityGatePassed: true, modifiedLibraryReplacementPassed: true, disposableDeploymentPassed: true,
  deploymentReportSha256: hash(readFileSync(resolve(deploymentPath))), passed: true, distributionApproved: false,
  remaining: ["Owner review of the complete paired source/notice delivery and publication checkpoint.",
    "Other platforms, signed/registry publication, full native rebuild/reproducibility and upgrade certification are not established by this platform-specific rehearsal."] };
writeFileSync(resolve(root, "binary-release-verification.json"), json(result));
console.log(json(result));
