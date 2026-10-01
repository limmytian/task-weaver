import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_PLATFORMS, platformArchitecture } from "./release-platforms.mjs";

const [directory, version] = process.argv.slice(2);
assert.ok(directory && version, "Usage: verify-ce-consumption.mjs <download-root> <version>");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const read = path => JSON.parse(readFileSync(path, "utf8"));
for (const platform of RELEASE_PLATFORMS) {
  const arch = platformArchitecture(platform);
  const root = resolve(directory, `ce-consumption-${arch}`);
  const path = resolve(root, "deployment-verification.json");
  const deployment = read(path);
  const loadPath = resolve(root, "bundle/ce-load-verification.json");
  const loaded = read(loadPath);
  const candidate = read(`release-artifacts/bundle/ce-candidate-${arch}.json`);
  for (const gate of ["passed", "migrationPassed", "searchSetupPassed", "apiHealthy", "webHealthy", "restCreateReadPassed"]) assert.equal(deployment[gate], true);
  assert.equal(deployment.buildMetadataPassed, true);
  assert.deepEqual(deployment.build, { commit, version });
  assert.equal(deployment.platform, platform);
  assert.equal(loaded.passed, true);
  assert.equal(loaded.commit, commit);
  assert.equal(loaded.version, version);
  assert.equal(loaded.platform, platform);
  assert.deepEqual(loaded.images.map(image => image.app).sort(), ["api", "web"]);
  assert.equal(deployment.imageIds.length, 2);
  for (const image of loaded.images) {
    assert.equal(image.platform, platform);
    assert.equal(image.configDigest, candidate.images.find(entry => entry.app === image.app)?.configDigest);
    assert.ok(deployment.imageIds.some(entry => entry.imageId === image.imageId && entry.platform === platform));
  }
  copyFileSync(path, `release-artifacts/bundle/consumption-${arch}.json`);
  copyFileSync(loadPath, `release-artifacts/bundle/ce-load-verification-${arch}.json`);
}
console.log("Independent native consumption and build identities verified for both platforms.");
