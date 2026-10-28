#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hash, json } from "./binary-source-lib.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";
import { releasePlatform } from "./release-platforms.mjs";

const [base, outputImage, requestedPlatform] = process.argv.slice(2);
if (!base || !outputImage || !requestedPlatform) throw new Error("Usage: node scripts/build-busybox-image.mjs <base-image> <output-image> <linux/amd64|linux/arm64>");
for (const value of [base, outputImage]) assert.match(value, /^[a-z0-9][a-z0-9._/:-]*$/, "Unsupported image reference");
assert.notEqual(base, outputImage, "Keep the base image unchanged");
const platform = releasePlatform(requestedPlatform);
const buildDirectory = resolve("release-artifacts/busybox-build", platform.split("/")[1]);
const reportBytes = readFileSync(join(buildDirectory, "verification.json"));
const build = JSON.parse(reportBytes);
assert.equal(build.platform, platform);
const binary = join(buildDirectory, "busybox");
assert.equal(hash(readFileSync(binary)), build.binarySha256, "BusyBox build output changed");
const before = inspectLocalImage(base, platform);
const config = before.Config;
assert.equal(config.User, "node");
assert.equal(config.WorkingDir, "/app");
assert.deepEqual(config.Entrypoint, ["docker-entrypoint.sh"]);
assert.ok(Array.isArray(config.Cmd) && config.Cmd.every((part) => typeof part === "string"));
assert.ok(!config.Healthcheck && !config.Volumes && !config.Labels && !config.OnBuild && !config.StopSignal, "Unreviewed image configuration");
const allowedEnvironment = new Set(["PATH", "TW_BUILD_COMMIT", "NODE_ENV", "TW_PRESET_SKILLS_DIR", "PORT", "HOSTNAME"]);
for (const value of config.Env ?? []) {
  const separator = value.indexOf("=");
  assert.ok(separator > 0 && allowedEnvironment.has(value.slice(0, separator)), "Unreviewed image environment");
  assert.ok(!/[\r\n\0]/.test(value));
}
assert.ok(Object.keys(config.ExposedPorts ?? {}).every((port) => /^\d+\/tcp$/.test(port)));
const scratch = mkdtempSync(join(tmpdir(), "tw-busybox-image-"));
try {
  copyFileSync(binary, join(scratch, "busybox"));
  assert.equal(hash(readFileSync(join(scratch, "busybox"))), build.binarySha256);
  const environment = (config.Env ?? []).map((item) => {
    const separator = item.indexOf("=");
    return `ENV ${item.slice(0, separator)}=${JSON.stringify(item.slice(separator + 1))}`;
  }).join("\n");
  const ports = Object.keys(config.ExposedPorts ?? {}).map((port) => `EXPOSE ${port}`).join("\n");
  const dockerfile = `FROM ${base} AS modified\nUSER root\nCOPY busybox /bin/busybox\nFROM scratch\nCOPY --from=modified / /\n${environment}\nWORKDIR /app\nUSER node\n${ports}\nENTRYPOINT ${JSON.stringify(config.Entrypoint)}\nCMD ${JSON.stringify(config.Cmd)}\n`;
  writeFileSync(join(scratch, "Dockerfile"), dockerfile);
  execFileSync("docker", ["build", "--platform", platform, "--tag", outputImage, scratch], { stdio: "inherit" });
  assert.equal(inspectLocalImage(base, platform).Id, before.Id, "Base image changed during build");
  const after = inspectLocalImage(outputImage, platform);
  for (const key of ["User", "WorkingDir", "Entrypoint", "Cmd", "ExposedPorts"]) assert.deepEqual(after.Config[key], config[key], `Image configuration changed: ${key}`);
  assert.deepEqual([...after.Config.Env].sort(), [...config.Env].sort(), "Image environment changed");
  assert.equal(hash(readFileSync(join(buildDirectory, "verification.json"))), hash(reportBytes), "BusyBox build report changed");
  const output = resolve("release-artifacts/busybox-image", after.Id.slice(7));
  mkdirSync(output, { recursive: true });
  const result = { schemaVersion: 1, base, baseImageId: before.Id, image: outputImage, imageId: after.Id, platform,
    busyboxSha256: build.binarySha256, buildReportSha256: hash(reportBytes), dockerfileSha256: hash(dockerfile),
    configurationPreserved: true, distributionApproved: false,
    limitation: "Local experimental image; source, layer, security, deployment and release evidence must be verified independently." };
  writeFileSync(join(output, "Dockerfile"), dockerfile);
  writeFileSync(join(output, "verification.json"), json(result));
  console.log(json(result));
} finally { rmSync(scratch, { recursive: true, force: true }); }
