import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_PLATFORMS, platformArchitecture } from "./release-platforms.mjs";
import { safePath } from "./binary-source-lib.mjs";

const [directory, version] = process.argv.slice(2);
assert.ok(directory && version, "Usage: load-ce-candidate-set.mjs <candidate-set-directory> <version>");
const root = resolve(directory);
mkdirSync(resolve("release-artifacts/bundle"), { recursive: true });
const set = JSON.parse(readFileSync(resolve(root, "ce-candidate-set.json")));
assert.equal(set.schemaVersion, 1);
assert.equal(set.version, version);
assert.equal(set.commit, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
assert.deepEqual(set.candidates.map(entry => entry.platform).sort(), [...RELEASE_PLATFORMS].sort(), "Both reviewed platforms are required");
for (const entry of set.candidates) {
  const platformRoot = resolve(root, safePath(entry.directory));
  const bytes = readFileSync(resolve(platformRoot, "ce-candidate.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.manifestSha256, "Platform manifest changed");
  const arch = platformArchitecture(entry.platform);
  const output = resolve(`release-artifacts/bundle-${arch}`);
  execFileSync(process.execPath, [resolve("scripts/load-ce-binary-candidate.mjs"), platformRoot, version, entry.platform, output], { stdio: "inherit" });
  for (const file of ["ce-candidate.json", "binary-release-verification.json", "corresponding-source.tar.gz", "api-image.sbom.json", "web-image.sbom.json", "api-vulnerabilities.json", "web-vulnerabilities.json"]) {
    copyFileSync(resolve(output, file), resolve("release-artifacts/bundle", file.replace(/(\.[^.]+(?:\.gz)?)$/, `-${arch}$1`)));
  }
}
copyFileSync(resolve(root, "ce-candidate-set.json"), resolve("release-artifacts/bundle/ce-candidate-set.json"));
console.log("Both platform candidates loaded without rebuilding.");
