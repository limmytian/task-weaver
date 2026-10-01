import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { safePath } from "./binary-source-lib.mjs";
import { imageArchiveConfig } from "./ce-image-archive.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

import { releasePlatform, platformArchitecture } from "./release-platforms.mjs";

const [directory, version, requestedPlatform, outputDirectory] = process.argv.slice(2);
if (!directory || !version) throw new Error("Usage: node scripts/load-ce-binary-candidate.mjs <candidate-directory> <version>");
const root = resolve(directory);
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const candidate = read("ce-candidate.json");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.ok([1, 2].includes(candidate.schemaVersion));
const platform = releasePlatform(requestedPlatform ?? candidate.platform);
const architecture = platformArchitecture(platform);
if (candidate.schemaVersion === 1) assert.equal(platform, "linux/arm64", "Legacy candidates cover ARM64 only");
else assert.equal(candidate.platform, platform, "Candidate platform does not match requested platform");
assert.equal(candidate.version, version);
assert.equal(candidate.commit, commit, "Binary candidate must come from the tagged public commit");
assert.deepEqual(candidate.images.map(({ app }) => app).sort(), ["api", "web"]);
for (const entry of candidate.images) {
  assert.equal(entry.platform ?? "linux/arm64", platform, "Candidate image platform mismatch");
  assert.match(entry.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.match(entry.imageRef, /^[a-z0-9][a-z0-9._/:-]*$/);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  const archive = join(root, safePath(entry.archive));
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(archive)) digest.update(bytes);
  assert.equal(digest.digest("hex"), entry.sha256, "Candidate image archive changed");
  assert.match(entry.configDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(imageArchiveConfig(archive, entry.imageRef, platform), entry.configDigest, "Archive runtime configuration changed");
}
// The trusted producer rechecks complete acquisitions before packaging. Only
// the sanitized corresponding-source sidecar and image-bound reports travel.
assert.ok(existsSync(join(root, "release-artifacts/binary-sources/source-lock.json")), "Missing candidate source-lock.json");
execFileSync(process.execPath, [resolve("scripts/verify-binary-release.mjs"), "release-artifacts/deployment-verification.json"], { cwd: root, stdio: "inherit" });
const verification = read("release-artifacts/binary-release-verification.json");
assert.equal(verification.passed, true);
assert.deepEqual(verification.images.map(({ imageId }) => imageId).sort(), candidate.images.map(({ imageId }) => imageId).sort());
const output = resolve(outputDirectory ?? "release-artifacts/bundle");
mkdirSync(output, { recursive: true });
const loadedImages = [];
for (const entry of candidate.images) {
  execFileSync("docker", ["load", "--input", join(root, safePath(entry.archive))], { stdio: "inherit" });
  const image = inspectLocalImage(entry.imageRef, platform);
  if (![entry.imageId, entry.configDigest].includes(image.Id)) {
    // Classic Docker archives become new OCI manifests in containerd stores.
    // The exact configuration digest binds runtime settings and layer diff IDs.
    const roundtrip = mkdtempSync(join(tmpdir(), "ce-loaded-image-"));
    try {
      const loadedArchive = join(roundtrip, "image.tar");
      execFileSync("docker", ["save", "--output", loadedArchive, entry.imageRef]);
      assert.equal(imageArchiveConfig(loadedArchive, entry.imageRef, platform), entry.configDigest,
        "Loaded image runtime configuration or layer identity changed");
    } finally {
      rmSync(roundtrip, { recursive: true, force: true });
    }
  }
  assert.equal(`${image.Os}/${image.Architecture}`, platform);
  loadedImages.push({ app: entry.app, imageId: image.Id, configDigest: entry.configDigest, platform });
  execFileSync("docker", ["tag", entry.imageRef, `task-weaver-${entry.app}:release${candidate.schemaVersion === 2 ? `-${architecture}` : ""}`]);
  const scans = read("release-artifacts/images/inventory.json");
  const scan = scans.inventory.find(({ imageId }) => imageId === entry.imageId);
  assert.ok(scan?.passed);
  copyFileSync(join(root, "release-artifacts/images", safePath(scan.sbom)), join(output, `${entry.app}-image.sbom.json`));
  copyFileSync(join(root, "release-artifacts/images", safePath(scan.vulnerabilities)), join(output, `${entry.app}-vulnerabilities.json`));
}
copyFileSync(join(root, "ce-candidate.json"), join(output, "ce-candidate.json"));
copyFileSync(join(root, "release-artifacts/binary-release-verification.json"), join(output, "binary-release-verification.json"));
copyFileSync(join(root, "release-artifacts/binary-sources", safePath(verification.correspondingSource.archive)), join(output, "corresponding-source.tar.gz"));
writeFileSync(join(output, "ce-load-verification.json"), JSON.stringify({ version, commit, platform, images: loadedImages, passed: true }, null, 2) + "\n");
console.log("Loaded verified CE binary candidate; publication approval is enforced by the protected release environment.");
