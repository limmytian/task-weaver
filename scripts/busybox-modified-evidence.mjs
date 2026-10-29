import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./binary-source-lib.mjs";
import { releasePlatform } from "./release-platforms.mjs";

export function assertModifiedBusyboxEvidence(image, imageReport, lock, lockBytes) {
  assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/);
  const platform = releasePlatform(image.platform);
  const root = resolve("release-artifacts");
  const buildRoot = resolve(root, "busybox-build", platform.split("/")[1]);
  const buildBytes = readFileSync(resolve(buildRoot, "verification.json"));
  const build = JSON.parse(buildBytes);
  const bindingBytes = readFileSync(resolve(root, "busybox-build/images", image.imageId.slice(7), "verification.json"));
  const layerBytes = readFileSync(resolve(root, "busybox-layers", image.imageId.slice(7), "verification.json"));
  const binding = JSON.parse(bindingBytes);
  const layers = JSON.parse(layerBytes);
  const sourceLockSha256 = hash(lockBytes);
  assert.equal(lock.busyboxBuildInputs?.configuration, "original-alpine", "BusyBox build source inputs are missing");
  assert.equal(lock.busyboxBuildInputs.patch, "alpine-busybox/patches/wget-CVE-2025-60876.patch");
  assert.deepEqual(lock.busyboxBuildInputs.staticLibraries, ["alpine-utmps", "alpine-skalibs"]);
  assert.equal(build.patchCount, 44);
  assert.equal(build.sourceDateEpoch, 1767225600);
  assert.match(build.builderImageId ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(build.compilerInputs?.length, 3);
  for (const [index, path] of ["/usr/bin/gcc", "/usr/bin/ld", "/lib/apk/db/installed"].entries()) {
    const line = build.compilerInputs[index];
    assert.match(line, /^[a-f0-9]{64}  \/[A-Za-z0-9/]+$/);
    assert.equal(line.slice(66), path);
  }
  const libraries = platform === "linux/amd64"
    ? ["d88866df1679446da3c7e81137a10e10752aac1444d610efb5d30d341c8e9b49", "99bf46ed6677bd7880a1f4db320bdcc928baacba65bbed596bef1927a9baa99b"]
    : ["a3505c4a591ffe7433c524676f36c34c2c5a09214919c342e134bf3a394a7b17", "d5ebd65ca3d2902e78b3fd87ae90c6bc51fa1ad865a11c52232b2d03617a6c5a"];
  assert.deepEqual(build.staticLibrarySha256, libraries);
  assert.equal(build.platform, platform);
  assert.equal(build.sourceLockSha256, sourceLockSha256, "BusyBox build uses another source lock");
  assert.equal(build.buildScriptSha256, hash(readFileSync(resolve("scripts/build-reviewed-busybox.mjs"))), "BusyBox build script changed");
  assert.equal(build.dockerfileSha256, hash(readFileSync(resolve(buildRoot, "Dockerfile"))), "BusyBox build recipe changed");
  assert.equal(build.patchListSha256, hash(readFileSync(resolve(buildRoot, "patch-list"))), "BusyBox patch order changed");
  assert.equal(build.binarySha256, hash(readFileSync(resolve(buildRoot, "busybox"))), "BusyBox build output changed");
  assert.equal(imageReport.busyboxPackageIntegrity?.sha256, build.binarySha256, "Image BusyBox differs from build output");
  assert.equal(binding.passed, true);
  assert.equal(binding.imageId, image.imageId);
  assert.equal(binding.platform, platform);
  assert.equal(binding.sourceLockSha256, sourceLockSha256);
  assert.equal(binding.binarySha256, build.binarySha256);
  assert.equal(binding.buildReportSha256, hash(buildBytes));
  assert.equal(layers.passed, true);
  assert.equal(layers.imageId, image.imageId);
  assert.equal(layers.platform, platform);
  assert.equal(layers.expectedSha256, build.binarySha256);
  assert.ok(layers.findings?.length > 0 && layers.findings.every((entry) => entry.sha256 === build.binarySha256));
  return { imageId: image.imageId, platform, binarySha256: build.binarySha256, buildReportSha256: hash(buildBytes),
    buildScriptSha256: build.buildScriptSha256, dockerfileSha256: build.dockerfileSha256, patchListSha256: build.patchListSha256,
    bindingSha256: hash(bindingBytes), layerReportSha256: hash(layerBytes) };
}
