#!/usr/bin/env node

import { listSavedImageLayer } from "./image-layer-listing.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

const [image, platform = "linux/arm64"] = process.argv.slice(2);
if (!image) throw new Error("Usage: node scripts/verify-runtime-layers.mjs <local-image> [linux/arm64]");
const details = inspectLocalImage(image, platform);
const root = resolve("release-artifacts/runtime-layers", details.Id.slice(7));
mkdirSync(root, { recursive: true });
const archive = resolve(root, "image.tar");
const save = spawnSync("docker", ["image", "save", "--output", archive, image], { encoding: "utf8" });
assert.equal(save.status, 0, save.stderr);
const manifest = spawnSync("tar", ["-xOf", archive, "--", "manifest.json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
assert.equal(manifest.status, 0, manifest.stderr);
const layers = JSON.parse(manifest.stdout)[0].Layers;
const forbidden = [];
for (const layer of layers) {
  for (const path of listSavedImageLayer(archive, layer, resolve(root, "inspected-layer.tar"))) {
    const name = path.replace(/^\.\//, "");
    if (/^(?:usr\/local\/lib\/node_modules\/(?:npm|corepack)(?:\/|$)|opt\/yarn-|sbin\/apk$|usr\/local\/bin\/(?:npm|npx|corepack|yarn|yarnpkg|pnpm|pnpx)$)/.test(name)) forbidden.push({ layer, path: name });
  }
}
assert.equal(inspectLocalImage(image, platform).Id, details.Id, "Image changed during layer inspection");
const report = { schemaVersion: 1, image, imageId: details.Id, platform, layers: layers.length, forbidden,
  passed: forbidden.length === 0, scope: "All delivered image layers, not only the merged root filesystem", distributionApproved: false };
writeFileSync(resolve(root, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
assert.equal(forbidden.length, 0, "Removed package managers remain in delivered OCI layers");
