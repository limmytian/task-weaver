#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { alpineRemoteSources, expandVersion, getText, json, safePath } from "./binary-source-lib.mjs";

const [evidenceDirectory] = process.argv.slice(2);
if (!evidenceDirectory) throw new Error("Usage: node scripts/prepare-binary-sources.mjs <binary-license-evidence-directory>");
const root = resolve(evidenceDirectory);
const inventory = JSON.parse(readFileSync(resolve(root, "inventory.json")));
const reports = inventory.inventory.map((image) => JSON.parse(readFileSync(resolve(root, safePath(image.report)))));
if (reports.some((report, index) => report.imageId !== inventory.inventory[index].imageId ||
    report.runtime?.version !== "24.21.0" || !/^sha256:[a-f0-9]{64}$/.test(report.imageId ?? ""))) {
  throw new Error("Collect current, image-ID-bound Node 24.21.0 runtime evidence first.");
}
const output = resolve("release-artifacts/binary-sources");
mkdirSync(output, { recursive: true });
const components = [];
const files = [];
const nativeCommit = "ebb95f8add54eee8bed840e3fb587e4cbec857d7";
const nativeRoot = `https://raw.githubusercontent.com/lovell/sharp-libvips/${nativeCommit}`;
const properties = getText(`${nativeRoot}/versions.properties`);
const versions = Object.fromEntries(properties.trim().split("\n").map((line) => line.split("=")));
const recipe = getText(`${nativeRoot}/build/posix.sh`);
const add = (component, kind, url, filename, extra = {}) => files.push({ component, kind, url,
  path: `${component}/${safePath(filename)}`, ...extra });

const os = new Map();
for (const report of reports) {
  if (report.osFamily !== "alpine") throw new Error("Only the reviewed Alpine runtime baseline is supported.");
  for (const pkg of report.osSourcePackages) {
    if (!/^[a-f0-9]{40}$/.test(pkg.c)) throw new Error("Missing exact Alpine source commit.");
    const key = `${pkg.o}-${pkg.c}`;
    const entry = os.get(key) ?? { origin: pkg.o, commit: pkg.c, packages: [] };
    if (!entry.packages.some((item) => item.name === pkg.P)) entry.packages.push({ name: pkg.P, version: pkg.V, license: pkg.L });
    os.set(key, entry);
  }
}
for (const entry of os.values()) {
  const component = `alpine-${safePath(entry.origin)}`;
  console.log(`Preparing ${component}`);
  const directory = JSON.parse(getText(`https://api.github.com/repos/alpinelinux/aports/contents/main/${entry.origin}?ref=${entry.commit}`));
  if (!Array.isArray(directory) || directory.some((file) => file.type !== "file")) throw new Error("Unsupported Alpine recipe directory layout.");
  const apk = directory.find((file) => file.name === "APKBUILD");
  const parsed = alpineRemoteSources(getText(apk.download_url));
  if (entry.packages.some((pkg) => pkg.version !== parsed.version)) throw new Error(`Alpine version drift: ${entry.origin}`);
  for (const file of directory) add(component, "recipe", file.download_url, `recipe/${file.name}`, { gitBlob: file.sha,
    ...(parsed.checksums.has(file.name) ? { sha512: parsed.checksums.get(file.name) } : {}) });
  for (const file of parsed.files) add(component, "source", file.url, `source/${file.filename}`, { sha512: file.sha512 });
  components.push({ id: component, family: "alpine", ...entry });
  if (entry.origin === "alpine-baselayout") {
    // APKBUILD downloads the protocol/service data from this exact netbase tag.
    add(component, "license", "https://salsa.debian.org/md/netbase/-/raw/v6.4/debian/copyright", "netbase-6.4-copyright.txt");
  }
}

const native = reports.flatMap((report) => report.nativeLibraries);
if (native.length) {
  for (const pkg of native) {
    if (pkg.version !== "1.3.4" || Object.entries(pkg.libraries).some(([key, value]) => versions[`VERSION_${key.toUpperCase().replaceAll("-", "_")}`] !== value)) {
      throw new Error("Native versions do not match the exact build recipe.");
    }
  }
  components.push({ id: "sharp-libvips-build", family: "native-recipe", version: "1.3.4", commit: nativeCommit });
  add("sharp-libvips-build", "source", `https://codeload.github.com/lovell/sharp-libvips/tar.gz/${nativeCommit}`, "recipe.tar.gz");
  for (const match of recipe.matchAll(/^\s*\$CURL (https:\/\/[^|\n]+?)(?:\s+\|)/gm)) {
    const url = expandVersion(match[1].trim(), versions);
    const versionKey = match[1].match(/VERSION_([A-Z0-9_]+)/)?.[1];
    const component = versionKey ? `native-${versionKey.toLowerCase().replaceAll("_", "-")}` : "sharp-libvips-build";
    const filename = new URL(url).pathname.split("/").at(-1);
    if (versionKey) components.push({ id: component, family: "native", version: versions[`VERSION_${versionKey}`] });
    add(component, versionKey ? "source" : "patch", url, safePath(filename));
  }
  components.push({ id: "sharp-addon", family: "native-addon", version: "0.35.5" });
  add("sharp-addon", "source", "https://codeload.github.com/lovell/sharp/tar.gz/v0.35.5", "sharp-0.35.5.tar.gz");
}
components.push({ id: "node-runtime", family: "runtime", version: "24.21.0" });
add("node-runtime", "source", "https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz", "node-v24.21.0.tar.xz");
const nodeSums = getText("https://nodejs.org/dist/v24.21.0/SHASUMS256.txt");
files.at(-1).sha256 = nodeSums.match(/^([a-f0-9]{64})\s+node-v24\.21\.0\.tar\.xz$/m)?.[1];
if (!files.at(-1).sha256) throw new Error("Node source checksum is unavailable.");
components.push({ id: "common-license-texts", family: "license-texts", version: "SPDX-3.27.0" });
for (const name of ["GPL-2.0-only", "GPL-3.0-only", "LGPL-2.1-only", "LGPL-3.0-only", "MIT", "BSD-2-Clause", "MPL-2.0"]) {
  add("common-license-texts", "license", `https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/${name}.txt`, `${name}.txt`);
}
const previousPath = resolve(output, "source-lock.json");
if (existsSync(previousPath)) {
  const previous = JSON.parse(readFileSync(previousPath)).files;
  for (const file of files) {
    const retained = previous.find((entry) => entry.path === file.path && entry.url === file.url);
    if (!file.sha256 && retained?.sha256) file.sha256 = retained.sha256;
  }
}

writeFileSync(resolve(output, "source-plan.json"), json({ schemaVersion: 1, images: inventory.inventory.map(({ image, imageId, platform }) => ({ image, imageId, platform })),
  components, files, distributionChecklist: ["Archive and verify all source inputs; review acquisition checksums before distributing.",
    "Verify the post-edit librsvg Cargo.lock and vendor all exact Rust crate sources.",
    "Extract complete component license/copyright texts; verify replacement/relinking and distribution terms."] }));
console.log(`Prepared ${components.length} components and ${files.length} files. This is a plan, not binary-distribution approval.`);
