#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { inspectLocalImage, redactScannerHostPaths } from "./image-inspection-lib.mjs";

// Syft reads local Docker images. Grype queries its downloaded advisory database;
// repository files and image contents are not uploaded to a scanning service.
const args = process.argv.slice(2);
const external = args.includes("--external");
const platform = args.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length);
const images = args.filter((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--external" && !arg.startsWith("--platform=")) ||
    (platform !== undefined && !/^linux\/(?:arm64|amd64)(?:\/v[0-9]+)?$/.test(platform))) {
  throw new Error("Unsupported option or platform; use --platform=linux/arm64 or linux/amd64.");
}
if (images.length === 0) {
  console.error("Usage: node scripts/inspect-release-images.mjs [--platform=linux/arm64] [--external] <local-image> [...local-images]");
  process.exit(1);
}
const output = resolve(external ? "release-artifacts/external-images" : "release-artifacts/images");
mkdirSync(output, { recursive: true });
const run = (name, args) => {
  // Use exactly the validated database recorded below, not an implicit update mid-run.
  const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GRYPE_DB_AUTO_UPDATE: "false" } });
  if (result.error) throw result.error;
  return result;
};
const inventory = [];
let failed = false;
try {
  const toolchain = {};
  for (const tool of ["syft", "grype"]) {
    const result = run(tool, ["version", "-o", "json"]);
    if (result.status !== 0) throw new Error(`Unable to read ${tool} version.`);
    toolchain[tool] = JSON.parse(result.stdout).version;
  }
  const db = run("grype", ["db", "status", "-o", "json"]);
  if (db.status !== 0) throw new Error("A valid Grype advisory database is required; run grype db update.");
  const database = JSON.parse(db.stdout);
  if (database.valid !== true) throw new Error("Grype advisory database is invalid.");
  toolchain.database = { schemaVersion: database.schemaVersion, built: database.built, valid: database.valid };
  writeFileSync(resolve(output, "toolchain.json"), `${JSON.stringify(toolchain, null, 2)}\n`);
  for (const [index, image] of images.entries()) {
    const name = `image-${index + 1}`;
    const details = platform ? inspectLocalImage(image, platform) : JSON.parse(run("docker", ["image", "inspect", image]).stdout)[0];
    const sbomPath = resolve(output, `${name}.cdx.json`);
    const scan = run("syft", [`docker:${image}`, ...(platform ? ["--platform", platform] : []), "-o", `cyclonedx-json=${sbomPath}`]);
    if (scan.status !== 0) throw new Error(`Syft failed for ${image}; exit ${scan.status}`);
    const vulnerabilitiesPath = resolve(output, `${name}.vulnerabilities.json`);
    const vulnerabilities = run("grype", [`sbom:${sbomPath}`, "-o", "json", "--fail-on", "high"]);
    if (![0, 2].includes(vulnerabilities.status)) {
      throw new Error(`Grype failed for ${image}; exit ${vulnerabilities.status}`);
    }
    const report = redactScannerHostPaths(JSON.parse(vulnerabilities.stdout));
    writeFileSync(vulnerabilitiesPath, `${JSON.stringify(report, null, 2)}\n`);
    if (platform && inspectLocalImage(image, platform).Id !== details.Id) throw new Error("Image changed during SBOM/vulnerability inspection");
    const counts = {};
    for (const match of report.matches ?? []) {
      const severity = match.vulnerability.severity;
      counts[severity] = (counts[severity] ?? 0) + 1;
    }
    const blocking = vulnerabilities.status === 2 || Object.entries(counts).some(([severity, count]) => /^(?:high|critical)$/i.test(severity) && count > 0);
    failed ||= blocking;
    inventory.push({ image, imageId: details.Id, platform: `${details.Os}/${details.Architecture}`, size: details.Size,
      sbom: `${name}.cdx.json`, sha256: createHash("sha256").update(readFileSync(sbomPath)).digest("hex"),
      vulnerabilities: `${name}.vulnerabilities.json`, counts, passed: !blocking });
  }
  writeFileSync(resolve(output, "inventory.json"), `${JSON.stringify({ schemaVersion: 1, scope: external ? "external-deployment-evidence" : "first-party-release", inventory }, null, 2)}\n`);
  console.log(JSON.stringify(inventory, null, 2));
  if (failed && !external) throw new Error("Container release blocked by high or critical image vulnerabilities.");
  if (failed && external) console.log("External deployment findings recorded; not a first-party release approval.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
