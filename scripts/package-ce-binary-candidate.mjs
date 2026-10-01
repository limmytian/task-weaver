import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { imageArchiveConfig } from "./ce-image-archive.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";

import { releasePlatform } from "./release-platforms.mjs";

const [version, apiImage, webImage, requestedPlatform] = process.argv.slice(2);
const platform = releasePlatform(requestedPlatform);
if (!version || !apiImage || !webImage) throw new Error("Usage: node scripts/package-ce-binary-candidate.mjs <version> <api-image> <web-image>");
assert.ok(existsSync("LICENSE") && !existsSync("open-source.manifest.json"), "Package only a verified independent public checkout");
assert.equal(JSON.parse(readFileSync("packages/contracts/package.json")).version, version);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Candidate checkout must be clean");
execFileSync(process.execPath, ["scripts/verify-binary-source-evidence.mjs", "release-artifacts/binary-sources/source-lock.json", "release-artifacts/binary-licenses", "release-artifacts/native-replacement/verification.json"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/verify-binary-release.mjs", "release-artifacts/deployment-verification.json"], { stdio: "inherit" });
const verification = JSON.parse(readFileSync("release-artifacts/binary-release-verification.json"));
assert.equal(verification.passed, true);
const output = resolve("release-artifacts/ce-binary-candidate");
mkdirSync(output, { recursive: true });
const images = [];
for (const [app, image] of [["api", apiImage], ["web", webImage]]) {
  const details = inspectLocalImage(image, platform);
  assert.ok(verification.images.some(entry => entry.imageId === details.Id && entry.platform === platform));
  const archive = `${app}-image.tar`;
  execFileSync("docker", ["save", "--output", join(output, archive), image]);
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(join(output, archive))) digest.update(bytes);
  images.push({ app, platform, imageId: details.Id, imageRef: image, configDigest: imageArchiveConfig(join(output, archive), image, platform), archive, sha256: digest.digest("hex") });
}
for (const path of ["binary-licenses", "images", "deployment-verification.json", "binary-release-verification.json", "native-replacement/verification.json",
  ...verification.images.map(({ imageId }) => `runtime-layers/${imageId.slice(7)}/verification.json`),
  "binary-sources/source-lock.json", "binary-sources/source-package.json", "binary-sources/binary-source-verification.json", `binary-sources/${verification.correspondingSource.archive}`]) {
  cpSync(resolve("release-artifacts", path), join(output, "release-artifacts", path), { recursive: true });
}
writeFileSync(join(output, "ce-candidate.json"), `${JSON.stringify({ schemaVersion: 2, version, commit, platform, images }, null, 2)}\n`);
console.log(output);
