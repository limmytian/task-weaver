#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hash, json } from "./binary-source-lib.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";
import { releasePlatform } from "./release-platforms.mjs";

const [image, requestedPlatform, expected] = process.argv.slice(2);
if (!image || !requestedPlatform || !expected) throw new Error("Usage: node scripts/verify-busybox-layers.mjs <image> <platform> <busybox-sha256>");
const platform = releasePlatform(requestedPlatform);
assert.match(expected, /^[a-f0-9]{64}$/, "Expected BusyBox SHA-256 is required");
const details = inspectLocalImage(image, platform);
const output = resolve("release-artifacts/busybox-layers", details.Id.slice(7));
rmSync(output, { recursive: true, force: true });
const scratch = mkdtempSync(join(tmpdir(), "tw-busybox-layers-"));
const archive = join(scratch, "image.tar");
const layerPath = join(scratch, "layer.tar");
const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
try {
  execute("docker", ["image", "save", "--output", archive, image]);
  const manifest = JSON.parse(execute("tar", ["-xOf", archive, "--", "manifest.json"], { maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(manifest.length, 1, "Expected one saved image");
  const findings = [];
  for (const layer of manifest[0].Layers) {
    assert.match(layer, /^(?:[a-f0-9]{64}\/layer\.tar|blobs\/sha256\/[a-f0-9]{64})$/);
    const fd = openSync(layerPath, "w", 0o600);
    try { execute("tar", ["-xOf", archive, "--", layer], { stdio: ["ignore", fd, "pipe"] }); }
    finally { closeSync(fd); }
    const names = execute("tar", ["-tf", layerPath], { maxBuffer: 64 * 1024 * 1024 }).split("\n")
      .filter((name) => name.replace(/^\.\//, "") === "bin/busybox");
    assert.ok(names.length <= 1, "Duplicate BusyBox entries in a layer");
    if (names.length) {
      const bytes = execute("tar", ["-xOf", layerPath, "--", names[0]], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
      const sha256 = hash(bytes);
      findings.push({ layer, sha256 });
    }
    rmSync(layerPath, { force: true });
  }
  assert.equal(inspectLocalImage(image, platform).Id, details.Id, "Image changed during layer inspection");
  const passed = findings.length > 0 && findings.every((finding) => finding.sha256 === expected);
  const report = { schemaVersion: 1, image, imageId: details.Id, platform, expectedSha256: expected, findings, passed,
    distributionApproved: false, scope: "All saved layer entries at bin/busybox; other paths and source provenance are not covered" };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "verification.json"), json(report));
  console.log(json(report));
  assert.ok(passed, "Missing or unexpected BusyBox binary in image layers");
} finally { rmSync(scratch, { recursive: true, force: true }); }
