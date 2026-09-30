#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash, json } from "./binary-source-lib.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

const [image, platform = "linux/arm64"] = process.argv.slice(2);
if (!image || !/^linux\/(arm64|amd64)$/.test(platform)) throw new Error("Usage: node scripts/verify-native-replacement.mjs <local-web-image> [linux/arm64]");
const run = (args, options = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`Replacement verification command failed: ${args[0]}\n${result.stderr}`);
  return result.stdout.trim();
};
const details = inspectLocalImage(image, platform);
assert.ok(["node", "1000", "1000:1000"].includes(details.Config.User), "Application image must default to the non-root user");
const imageId = details.Id;
const root = resolve("release-artifacts/native-replacement");
mkdirSync(resolve(root, "replacement"), { recursive: true });
const discover = () => {
  const fs = require("node:fs");
  const pnpm = "/app/node_modules/.pnpm";
  const folders = fs.readdirSync(pnpm);
  const lib = folders.find((entry) => entry.startsWith(`@img+sharp-libvips-linuxmusl-${process.arch}@`));
  const sharp = folders.find((entry) => /^sharp@/.test(entry));
  if (!lib || !sharp) throw new Error("Unsupported native runtime layout.");
  const directory = `${pnpm}/${lib}/node_modules/@img/sharp-libvips-linuxmusl-${process.arch}/lib`;
  const file = fs.readdirSync(directory).find((entry) => /^libvips-cpp\.so\./.test(entry));
  if (!file) throw new Error("Native shared library is unavailable.");
  return { directory, filename: file, sharp: `${pnpm}/${sharp}/node_modules/sharp` };
};
const location = JSON.parse(run(["run", "--rm", "--pull=never", "--platform", platform, "--network=none", "--read-only", "--entrypoint", "node", image,
  "-e", `console.log(JSON.stringify((${discover.toString()})()))`]));
assert.match(location.filename, /^libvips-cpp\.so\.\d+(?:\.\d+)*$/, "Unsupported native SONAME");
const copyContainer = run(["create", "--platform", platform, "--entrypoint", "node", image]);
try { run(["cp", `${copyContainer}:${location.directory}/${location.filename}`, resolve(root, "original.so")]); }
finally { run(["rm", copyContainer]); }
const baselineHash = hash(readFileSync(resolve(root, "original.so")));
const build = `cp /work/original.so /work/replacement/libvips-original.so &&
patchelf --set-soname libvips-original.so /work/replacement/libvips-original.so &&
tcc -nostdlib -shared /fixture.c -Wl,-soname,${location.filename} /work/replacement/libvips-original.so -Wl,-rpath,'$ORIGIN' -o /work/replacement/${location.filename}`;
const compilerImage = "node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2";
// BuildKit's cache does not populate the Docker engine's local image store.
run(["pull", "--platform", platform, compilerImage]);
console.log("Building the user-modified replacement in a disposable compiler container.");
run(["run", "--rm", "--pull=never", "--platform", platform, "--user", "root", "--mount", `type=bind,source=${root},target=/work`,
  "--mount", `type=bind,source=${resolve(import.meta.dirname, "fixtures/libvips-replacement.c")},target=/fixture.c,readonly`,
  "--entrypoint", "sh", compilerImage,
  "-c", `apk add --no-cache tcc musl-dev patchelf >/tmp/test-tools.log && ${build}`]);
const processing = `const sharp=require(${JSON.stringify(location.sharp)}); sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer().then(b=>sharp(b).metadata()).then(m=>{if(m.width!==2||m.height!==2)throw new Error('Native processing mismatch');console.log(JSON.stringify({width:m.width,height:m.height}))})`;
const baseline = run(["run", "--rm", "--pull=never", "--platform", platform, "--network=none", "--read-only", "--entrypoint", "node", image, "-e", processing]);
const result = spawnSync("docker", ["run", "--rm", "--pull=never", "--platform", platform, "--network=none", "--read-only",
  "--mount", `type=bind,source=${resolve(root, "replacement")},target=${location.directory},readonly`, "--entrypoint", "node", image, "-e", processing],
{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stderr, /VIPS_USER_REPLACEMENT_ACTIVE/);
assert.equal(result.stdout.trim(), baseline);
mkdirSync(resolve(root, "missing-library"), { recursive: true });
const negative = spawnSync("docker", ["run", "--rm", "--pull=never", "--platform", platform, "--network=none", "--read-only",
  "--mount", `type=bind,source=${resolve(root, "missing-library")},target=${location.directory},readonly`, "--entrypoint", "node", image, "-e", processing], { encoding: "utf8" });
assert.notEqual(negative.status, 0, "Missing-library negative control must fail, not silently select another native library");
assert.match(negative.stderr, /sharp|DLOPEN|libvips/i);
const replacementHash = hash(readFileSync(resolve(root, "replacement", location.filename)));
assert.notEqual(replacementHash, baselineHash);
assert.equal(inspectLocalImage(image, platform).Id, imageId, "Image changed during verification");
writeFileSync(resolve(root, "verification.json"), json({ schemaVersion: 1, image, imageId, platform, uid: "node (image default)",
  libraryPath: `${location.directory}/${location.filename}`, originalSha256: baselineHash, replacementSha256: replacementHash,
  fixtureSha256: hash(readFileSync(resolve(import.meta.dirname, "fixtures/libvips-replacement.c"))), baseline: JSON.parse(baseline),
  replacement: JSON.parse(result.stdout), markerObserved: true, missingLibraryControlFailed: true, passed: true, distributionApproved: false,
  limitation: "Verifies replacement of the shared object with a user-modified wrapper, not rebuilding all upstream static native dependencies." }));
console.log("Modified shared-library replacement passed with non-root/read-only application runtime; this is not full source-rebuild or distribution approval.");
