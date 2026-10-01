import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { RELEASE_PLATFORMS, platformArchitecture } from "./release-platforms.mjs";
import { safePath } from "./binary-source-lib.mjs";
import { imageArchiveConfig } from "./ce-image-archive.mjs";

const [input, output, version] = process.argv.slice(2);
assert.ok(input && output && version, "Usage: merge-ce-binary-candidates.mjs <input-root> <output-root> <version>");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const candidates = [];
for (const platform of RELEASE_PLATFORMS) {
  const arch = platformArchitecture(platform);
  const directory = resolve(input, `ce-binary-candidate-${arch}`);
  const candidate = JSON.parse(readFileSync(join(directory, "ce-candidate.json")));
  assert.equal(candidate.schemaVersion, 2);
  assert.equal(candidate.version, version);
  assert.equal(candidate.commit, commit);
  assert.equal(candidate.platform, platform);
  assert.deepEqual(candidate.images.map(image => image.app).sort(), ["api", "web"]);
  for (const image of candidate.images) {
    assert.equal(image.platform, platform);
    const archive = join(directory, safePath(image.archive));
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(archive)) digest.update(bytes);
    assert.equal(digest.digest("hex"), image.sha256, "Candidate archive changed before aggregation");
    assert.equal(imageArchiveConfig(archive, image.imageRef, platform), image.configDigest);
  }
  const verification = JSON.parse(readFileSync(join(directory, "release-artifacts/binary-release-verification.json")));
  assert.equal(verification.passed, true);
  assert.deepEqual(verification.images.map(image => `${image.platform}:${image.imageId}`).sort(), candidate.images.map(image => `${image.platform}:${image.imageId}`).sort());
  const relative = `platforms/${arch}`;
  cpSync(directory, resolve(output, relative), { recursive: true });
  candidates.push({ platform, directory: relative, manifestSha256: createHash("sha256").update(readFileSync(join(directory, "ce-candidate.json"))).digest("hex") });
}
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "ce-candidate-set.json"), JSON.stringify({ schemaVersion: 1, version, commit, candidates }, null, 2) + "\n");
console.log("Aggregated independently verified AMD64 and ARM64 candidates.");
