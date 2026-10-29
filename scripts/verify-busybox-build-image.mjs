#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertChecksums, hash, json, safePath } from "./binary-source-lib.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";
import { releasePlatform } from "./release-platforms.mjs";

const [manifest, image, requestedPlatform] = process.argv.slice(2);
if (!manifest || !image || !requestedPlatform) throw new Error("Usage: node scripts/verify-busybox-build-image.mjs <source-lock.json> <local-image> <linux/amd64|linux/arm64>");
const platform = releasePlatform(requestedPlatform);
const lockBytes = readFileSync(resolve(manifest));
const lock = JSON.parse(lockBytes);
const buildDirectory = resolve("release-artifacts/busybox-build", platform.split("/")[1]);
const buildReportPath = join(buildDirectory, "verification.json");
const buildReportBytes = readFileSync(buildReportPath);
const build = JSON.parse(buildReportBytes);
assert.equal(build.platform, platform);
assert.equal(build.sourceLockSha256, hash(lockBytes), "Build source lock changed");
assert.equal(build.buildScriptSha256, hash(readFileSync(resolve("scripts/build-reviewed-busybox.mjs"))), "Build script changed");
assert.equal(build.dockerfileSha256, hash(readFileSync(join(buildDirectory, "Dockerfile"))), "Build recipe changed");
assert.equal(build.patchListSha256, hash(readFileSync(join(buildDirectory, "patch-list"))), "Build patch order changed");
assert.equal(build.binarySha256, hash(readFileSync(join(buildDirectory, "busybox"))), "Built BusyBox changed");
assert.ok(lock.busyboxBuildInputs && build.patchCount === 44);
for (const file of lock.files.filter((entry) => ["alpine-busybox", "alpine-utmps", "alpine-skalibs"].includes(entry.component))) {
  assertChecksums(file, resolve("release-artifacts/binary-sources", safePath(file.path)));
}
const details = inspectLocalImage(image, platform);
const output = resolve("release-artifacts/busybox-build/images", details.Id.slice(7));
rmSync(output, { recursive: true, force: true });
const script = 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync("/bin/busybox")).digest("hex"))';
const run = spawnSync("docker", ["run", "--rm", "--pull=never", "--platform", platform, "--network", "none", "--read-only", "--entrypoint", "node", image, "-e", script], { encoding: "utf8", timeout: 60000 });
assert.equal(run.status, 0, `Unable to inspect image BusyBox: ${run.error?.message ?? run.stderr}`);
assert.equal(run.stdout, build.binarySha256, "Image BusyBox differs from local build output");
assert.equal(inspectLocalImage(image, platform).Id, details.Id, "Image changed during inspection");
assert.equal(hash(readFileSync(resolve(manifest))), hash(lockBytes), "Source lock changed during inspection");
assert.equal(hash(readFileSync(buildReportPath)), hash(buildReportBytes), "Build report changed during inspection");
const report = { schemaVersion: 1, image, imageId: details.Id, platform, sourceLockSha256: build.sourceLockSha256,
  binarySha256: build.binarySha256, buildReportSha256: hash(buildReportBytes),
  passed: true, distributionApproved: false,
  limitation: "Local output-to-image comparison, not independent provenance, layer history, notice review, or distribution approval." };
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "verification.json"), json(report));
console.log(json(report));
