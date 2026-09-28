#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

const args = process.argv.slice(2);
const platform = args.find((arg) => arg.startsWith("--platform="))?.slice(11) ?? "linux/arm64";
const images = args.filter((arg) => !arg.startsWith("--"));
if (!/^linux\/(?:arm64|amd64)$/.test(platform) || images.length === 0 ||
    args.some((arg) => arg.startsWith("--") && !arg.startsWith("--platform="))) {
  throw new Error("Usage: node scripts/collect-image-license-evidence.mjs --platform=linux/arm64 <local-image> [...local-images]");
}

// This only reads known license files and package metadata in the final image.
// It never reads runtime environment variables or credential files.
const inspect = () => {
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const { gunzipSync } = require("node:zlib");
  const { spawnSync } = require("node:child_process");
  const hash = (content) => crypto.createHash("sha256").update(content).digest("hex");
  const fonts = [];
  const nativeAddons = [];
  const nativeLibraries = [];
  const nativeToolchains = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (file.isSymbolicLink()) continue;
      const path = `${dir}/${file.name}`;
      if (file.isDirectory()) walk(path);
      else if (/\.woff2?$/.test(path)) fonts.push({ path, sha256: hash(fs.readFileSync(path)) });
      else if (/\.node$/.test(path)) nativeAddons.push({ path, sha256: hash(fs.readFileSync(path)) });
      else if (/^libvips-cpp\.so\./.test(file.name)) {
        const bytes = fs.readFileSync(path);
        const rustCommits = [...new Set([...bytes.toString("latin1").matchAll(/\/rustc\/([a-f0-9]{40})\/library\//g)].map((match) => match[1]))].sort();
        nativeToolchains.push({ path, sha256: hash(bytes), rustCommits });
      }
      else if (file.name === "versions.json" && path.includes("@img/sharp-libvips-")) {
        const packagePath = dir;
        const pkg = JSON.parse(fs.readFileSync(`${packagePath}/package.json`));
        nativeLibraries.push({ name: pkg.name, version: pkg.version, libraries: JSON.parse(fs.readFileSync(path)), path });
      }
    }
  };
  walk("/app");
  const copyrights = [];
  for (const file of fs.existsSync("/usr/share/doc") ? fs.readdirSync("/usr/share/doc", { withFileTypes: true }) : []) {
    if (!file.isDirectory()) continue;
    for (const name of ["copyright", "copyright.gz"]) {
      const path = `/usr/share/doc/${file.name}/${name}`;
      if (!fs.existsSync(path)) continue;
      const bytes = fs.readFileSync(path);
      copyrights.push({ path, sha256: hash(bytes), text: (name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8") });
    }
  }
  const apkPath = "/lib/apk/db/installed";
  const isAlpine = fs.existsSync(apkPath);
  const dpkg = isAlpine ? null : spawnSync("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\n"], { encoding: "utf8" });
  if (dpkg && dpkg.status !== 0) throw new Error("Unable to inventory operating-system source packages.");
  const osSourcePackages = isAlpine ? fs.readFileSync(apkPath, "utf8").trim().split("\n\n").map((record) =>
    Object.fromEntries(record.split("\n").filter((line) => /^[PVLoUc]:/.test(line)).map((line) => [line[0], line.slice(2)])))
    : dpkg.stdout.trim().split("\n");
  const nodeLicensePath = ["/usr/local/LICENSE", "/app/THIRD_PARTY_LICENSES/Node-24.21.0-LICENSE.txt"].find((path) => fs.existsSync(path));
  const dependencyTextsPath = "/app/release-artifacts/dependency-license-texts.txt";
  const dependencyTexts = fs.existsSync(dependencyTextsPath) ? fs.readFileSync(dependencyTextsPath, "utf8") : "";
  const notices = "/app/THIRD_PARTY_LICENSES/sharp-libvips-1.3.4-NOTICES.md";
  const runtimeNoticesPath = "/app/THIRD_PARTY_LICENSES/runtime-source-NOTICES.txt";
  const baselinePath = "/app/release-artifacts/binary-notice-baseline.json";
  const runtimeNoticesSha256 = fs.existsSync(runtimeNoticesPath) ? hash(fs.readFileSync(runtimeNoticesPath)) : null;
  const noticeBaseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath)) : null;
  const runtimeNoticeVerified = Boolean(noticeBaseline && noticeBaseline.noticeBundleSha256 === runtimeNoticesSha256 && noticeBaseline.nodeVersion === process.versions.node);
  const pending = [];
  if (!runtimeNoticeVerified) pending.push("Complete runtime/source notice bundle is missing or does not match its pinned baseline");
  if (isAlpine) pending.push("Alpine APK license declarations and source commits are inventoried; full OS license/source obligations require distribution review");
  if (!dependencyTexts) pending.push("Installed dependency license texts are missing");
  if (!nodeLicensePath) pending.push("Node runtime license is missing");
  if (fonts.length && !dependencyTexts.includes("Component: geist@")) pending.push("Font license evidence is missing");
  if (nativeLibraries.length) {
    if (!fs.existsSync(notices)) pending.push("Pinned native-library notices are missing");
    if (nativeLibraries.some((entry) => entry.version !== "1.3.4")) pending.push("Native-library version does not match the reviewed notice baseline");
    pending.push("Native-library corresponding source, build inputs, license texts, and replacement/relinking procedure require distribution review");
  }
  return { schemaVersion: 1, runtime: { name: "node", version: process.versions.node }, fonts, nativeAddons, nativeLibraries, nativeToolchains, copyrights,
    osFamily: isAlpine ? "alpine" : "debian", osSourcePackages,
    nodeLicense: nodeLicensePath ? { path: nodeLicensePath, sha256: hash(fs.readFileSync(nodeLicensePath)), text: fs.readFileSync(nodeLicensePath, "utf8") } : null,
    dependencyLicenseTextsSha256: hash(dependencyTexts), nativeNoticePresent: fs.existsSync(notices),
    runtimeNoticeVerified, runtimeNoticesSha256, noticeBaseline,
    distributionApproved: false, pending };
};

const output = resolve("release-artifacts/binary-licenses");
mkdirSync(output, { recursive: true });
const inventory = [];
for (const [index, image] of images.entries()) {
  const inspectImage = () => {
    return inspectLocalImage(image, platform).Id;
  };
  const imageId = inspectImage();
  const result = spawnSync("docker", ["run", "--rm", "--pull=never", "--platform", platform,
    "--network=none", "--read-only", "--entrypoint", "node", image, "-e", `console.log(JSON.stringify((${inspect.toString()})()))`],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Final-image license inspection failed for ${image}`);
  const report = JSON.parse(result.stdout);
  if (inspectImage() !== imageId) throw new Error("Image changed during license inspection.");
  report.imageId = imageId;
  const name = `image-${index + 1}.json`;
  writeFileSync(resolve(output, name), `${JSON.stringify(report, null, 2)}\n`);
  inventory.push({ image, imageId, platform, report: name, fontFiles: report.fonts.length,
    nativeAddons: report.nativeAddons.length, nativeLibraryPackages: report.nativeLibraries.length,
    osCopyrightFiles: report.copyrights.length, distributionApproved: report.distributionApproved, pending: report.pending });
}
writeFileSync(resolve(output, "inventory.json"), `${JSON.stringify({ schemaVersion: 1, inventory }, null, 2)}\n`);
console.log(JSON.stringify(inventory, null, 2));
console.log("License evidence collected; this command is not binary-distribution approval.");
