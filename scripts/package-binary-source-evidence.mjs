#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";

const [manifest] = process.argv.slice(2);
if (!manifest) throw new Error("Usage: node scripts/package-binary-source-evidence.mjs <verified-source-lock.json>");
const root = resolve("release-artifacts/binary-sources");
const bytes = readFileSync(resolve(manifest));
const lock = JSON.parse(bytes);
const verification = JSON.parse(readFileSync(resolve(root, "binary-source-verification.json")));
assert.equal(verification.sourceLockSha256, hash(bytes), "Run evidence verification for this exact lock before packaging");
assert.equal(verification.sourceIntegrityPassed, true);
const sourceOnlyRust = lock.files.some((file) => file.path.startsWith("rust-crates/"));
const delivery = sourceOnlyRust ? JSON.parse(readFileSync(resolve(root, "rust-source-delivery.json"))) : null;
if (delivery) assert.equal(delivery.linuxTreeReplayPassed, true);
const licenses = JSON.parse(readFileSync(resolve(root, "license-extraction.json")));
for (const file of licenses.evidence) assert.equal(hash(readFileSync(resolve(root, safePath(file.path)))), file.sha256);
const paths = [...new Set([...lock.files.filter((file) => file.kind !== "notice-container" && (!sourceOnlyRust || (!file.path.startsWith("rust-crates/") && file.path !== "rust-standard-library/rust-src-nightly.tar.xz"))).map((file) => safePath(file.path)),
  ...(lock.rustRuntimeEvidence?.registryDependencyLock ? [safePath(lock.rustRuntimeEvidence.registryDependencyLock.path)] : []),
  ...licenses.evidence.map((file) => safePath(file.path)), "license-texts.txt", "license-extraction.json", "runtime-source-NOTICES.txt", "notice-case-resolutions.json",
  "librsvg-release-Cargo.lock", "librsvg-post-edit-Cargo.lock", "rust-lock-verification.json", "rust-license-declarations.json", "binary-source-verification.json"])].sort();
assert.equal(new Set(paths).size, paths.length);
for (const file of lock.files) assertChecksums(file, resolve(root, file.path));
const buildDelivery = [];
if (verification.modifiedBusybox?.length) {
  const platforms = [...new Set(verification.modifiedBusybox.map((item) => item.platform))];
  assert.equal(platforms.length, 1, "Modified BusyBox sidecar must cover one platform");
  const architecture = platforms[0].split("/")[1];
  assert.ok(["amd64", "arm64"].includes(architecture));
  const first = verification.modifiedBusybox[0];
  assert.ok(verification.modifiedBusybox.every((item) => item.buildReportSha256 === first.buildReportSha256 && item.binarySha256 === first.binarySha256));
  const addBuildFile = (name, path, expected) => {
    const data = readFileSync(resolve(path));
    const sha256 = hash(data);
    if (expected) assert.equal(sha256, expected, `BusyBox build evidence changed: ${name}`);
    buildDelivery.push({ path: `busybox-build/${safePath(name)}`, data, sha256 });
  };
  const buildRoot = `release-artifacts/busybox-build/${architecture}`;
  addBuildFile("build-reviewed-busybox.mjs", "scripts/build-reviewed-busybox.mjs", first.buildScriptSha256);
  addBuildFile("binary-source-lib.mjs", "scripts/binary-source-lib.mjs");
  addBuildFile("release-platforms.mjs", "scripts/release-platforms.mjs");
  addBuildFile("Dockerfile", `${buildRoot}/Dockerfile`, first.dockerfileSha256);
  addBuildFile("patch-list", `${buildRoot}/patch-list`, first.patchListSha256);
  addBuildFile("verification.json", `${buildRoot}/verification.json`, first.buildReportSha256);
  for (const item of verification.modifiedBusybox) {
    assert.match(item.imageId, /^sha256:[a-f0-9]{64}$/);
    const id = item.imageId.slice(7);
    addBuildFile(`image-${id}.json`, `release-artifacts/busybox-build/images/${id}/verification.json`, item.bindingSha256);
    addBuildFile(`layers-${id}.json`, `release-artifacts/busybox-layers/${id}/verification.json`, item.layerReportSha256);
  }
  assert.ok(!paths.includes("busybox-build/source-index.json") && buildDelivery.every((entry) => !paths.includes(entry.path)), "Duplicate build delivery path");
}
const header = (path, size, mode = 0o644) => {
  safePath(path);
  const buffer = Buffer.alloc(512);
  const slash = path.lastIndexOf("/");
  const prefix = path.length <= 100 ? "" : path.slice(0, slash);
  const name = path.length <= 100 ? path : path.slice(slash + 1);
  assert.ok(name.length <= 100 && prefix.length <= 155, "Source path exceeds POSIX ustar limits");
  const field = (value, offset, length) => buffer.write(String(value), offset, length, "ascii");
  const octal = (value, offset, length) => {
    const text = value.toString(8).padStart(length - 1, "0");
    assert.ok(text.length < length, "Source size exceeds POSIX ustar limits");
    field(text, offset, length);
  };
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  buffer.fill(32, 148, 156);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field(prefix, 345, 155);
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buffer;
};
async function* archive() {
  // This is a release sidecar, not an application image. Only explicit public
  // source inputs/reports enter it; never scratch trees, credentials, or backups.
  yield header("source-lock.json", bytes.length);
  yield bytes;
  yield Buffer.alloc((512 - bytes.length % 512) % 512);
  for (const path of paths) {
    const source = resolve(root, path);
    const size = statSync(source).size;
    yield header(path, size);
    for await (const chunk of createReadStream(source)) yield chunk;
    yield Buffer.alloc((512 - size % 512) % 512);
  }
  if (buildDelivery.length) {
    const index = Buffer.from(json({ files: buildDelivery.map(({ path, sha256 }) => ({ path, sha256 })),
      limitation: "Build inputs and local image comparisons; not independent provenance or distribution approval." }));
    yield header("busybox-build/source-index.json", index.length);
    yield index;
    yield Buffer.alloc((512 - index.length % 512) % 512);
    for (const file of buildDelivery) {
      yield header(file.path, file.data.length);
      yield file.data;
      yield Buffer.alloc((512 - file.data.length % 512) % 512);
    }
  }
  if (delivery) {
    const index = Buffer.from(json({ files: delivery.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
      omittedImportLibraries: delivery.omittedImportLibraries, linuxTreeReplayPassed: true,
      acquisitionCatalog: "source-lock.json; raw crate/rust-src archives and compiled docs are acquisition-only; sanitized source files are delivered", distributionApproved: false }));
    yield header("rust-source-delivery.json", index.length);
    yield index;
    yield Buffer.alloc((512 - index.length % 512) % 512);
    for (const file of delivery.files) {
      const path = resolve(root, safePath(file.sourcePath));
      assert.equal(hash(readFileSync(path)), file.sha256);
      assert.ok([0o644, 0o755].includes(file.mode));
      const size = statSync(path).size;
      yield header(file.path, size, file.mode);
      for await (const chunk of createReadStream(path)) yield chunk;
      yield Buffer.alloc((512 - size % 512) % 512);
    }
    const coverage = JSON.parse(readFileSync(resolve(root, "linux-rust-source-coverage.json")));
    const treeFiles = coverage.trees.map(tree => `${tree.package === "std" ? "std-" : ""}${tree.target}-source-tree.txt`);
    for (const path of ["linux-rust-source-coverage.json", ...treeFiles]) {
      const data = readFileSync(resolve(root, path));
      yield header(path, data.length);
      yield data;
      yield Buffer.alloc((512 - data.length % 512) % 512);
    }
  }
  yield Buffer.alloc(1024);
}
const target = resolve(root, "corresponding-source-candidate.tar.gz");
await pipeline(Readable.from(archive()), createGzip({ level: 6 }), createWriteStream(target));
const digest = createHash("sha256");
for await (const chunk of createReadStream(target)) digest.update(chunk);
const report = { schemaVersion: 1, archive: "corresponding-source-candidate.tar.gz", sha256: digest.digest("hex"),
  bytes: statSync(target).size, members: paths.length + 1 + (buildDelivery.length ? buildDelivery.length + 1 : 0) + (delivery ? delivery.files.length + 2 + JSON.parse(readFileSync(resolve(root, "linux-rust-source-coverage.json"))).trees.length : 0), sourceLockSha256: hash(bytes), deterministicMetadata: true,
  sourceOnlyRustVendor: Boolean(delivery), omittedNativePayloads: delivery?.omittedImportLibraries.length ?? 0,
  distributionApproved: false,
  limitation: "Candidate source/notices sidecar; technical notice handling is complete, but owner review and explicit publication authorization remain required." };
writeFileSync(resolve(root, "source-package.json"), json(report));
console.log(json(report));
