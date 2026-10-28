import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { releasePlatform, platformArchitecture } from "./release-platforms.mjs";

const [version, requestedPlatform] = process.argv.slice(2);
const platform = releasePlatform(requestedPlatform);
const architecture = platformArchitecture(platform);
if (!version) throw new Error("Usage: node scripts/prepare-ce-binary-candidate.mjs <version>");
assert.ok(existsSync("LICENSE") && !existsSync("open-source.manifest.json"), "Use an independent verified public checkout");
assert.equal(JSON.parse(readFileSync("packages/contracts/package.json")).version, version);
const api = `task-weaver-api:ce-candidate-${architecture}`;
const web = `task-weaver-web:ce-candidate-${architecture}`;
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const script = (name, ...args) => run(process.execPath, [`scripts/${name}.mjs`, ...args]);
const root = "release-artifacts/binary-sources";
const baseApi = `task-weaver-api:ce-base-${architecture}`;
const baseWeb = `task-weaver-web:ce-base-${architecture}`;
for (const [app, image] of [["api", baseApi], ["web", baseWeb]]) {
  run("docker", ["buildx", "build", "--platform", platform, "--load", "--build-arg", `TW_BUILD_COMMIT=${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`, "--file", `apps/${app}/Dockerfile`, "--tag", image, "."]);
}
// Build from image-observed Alpine inputs before replacing the packaged binary.
script("collect-image-license-evidence", `--platform=${platform}`, baseApi, baseWeb);
script("prepare-binary-sources", "release-artifacts/binary-licenses");
script("assemble-binary-sources", `${root}/source-plan.json`, "--acquire");
script("prepare-busybox-build-sources", `${root}/source-lock.json`);
script("assemble-binary-sources", `${root}/busybox-build-source-plan.json`, "--acquire");
script("build-reviewed-busybox", `${root}/source-lock.json`, platform);
script("build-busybox-image", baseApi, api, platform);
script("build-busybox-image", baseWeb, web, platform);
for (const image of [api, web]) script("verify-busybox-wget", image, platform);
script("collect-image-license-evidence", `--platform=${platform}`, api, web);
script("prepare-binary-sources", "release-artifacts/binary-licenses");
script("assemble-binary-sources", `${root}/source-plan.json`, "--acquire");
script("prepare-busybox-build-sources", `${root}/source-lock.json`);
script("assemble-binary-sources", `${root}/busybox-build-source-plan.json`, "--acquire");
script("vendor-binary-rust-sources", `${root}/source-lock.json`);
script("assemble-binary-sources", `${root}/rust-source-plan.json`);
script("verify-librsvg-lock", `${root}/source-lock.json`);
script("extract-binary-licenses", `${root}/verified-source-lock.json`);
script("supplement-binary-license-plan", `${root}/verified-source-lock.json`);
script("assemble-binary-sources", `${root}/supplemental-source-plan.json`, "--acquire");
script("extract-binary-licenses", `${root}/source-lock.json`);
script("add-rust-runtime-inputs", `${root}/source-lock.json`, "release-artifacts/binary-licenses");
script("assemble-binary-sources", `${root}/rust-runtime-source-plan.json`, "--acquire");
script("vendor-binary-rust-sources", `${root}/source-lock.json`, "--runtime-dependencies");
script("assemble-binary-sources", `${root}/rust-runtime-dependencies-source-plan.json`);
script("verify-librsvg-lock", `${root}/source-lock.json`);
// Freeze the complete lock before building and binding the final BusyBox evidence.
run("cp", [`${root}/verified-source-lock.json`, `${root}/source-lock.json`]);
script("extract-binary-licenses", `${root}/source-lock.json`);
script("assemble-runtime-notices", `${root}/source-lock.json`);
assert.ok(readFileSync(`${root}/runtime-source-NOTICES.txt`).equals(readFileSync("THIRD_PARTY_LICENSES/runtime-source-NOTICES.txt")), "Acquired source notices differ from the reviewed notices delivered in the images");
script("build-reviewed-busybox", `${root}/source-lock.json`, platform);
const busybox = JSON.parse(readFileSync(`release-artifacts/busybox-build/${architecture}/verification.json`));
for (const image of [api, web]) {
  script("verify-busybox-build-image", `${root}/source-lock.json`, image, platform);
  script("verify-busybox-layers", image, platform, busybox.binarySha256);
}
const replacements = [];
for (const [app, image] of [["api", api], ["web", web]]) {
  const directory = `release-artifacts/native-replacement/${app}`;
  script("verify-native-replacement", image, platform, directory);
  replacements.push({ ...JSON.parse(readFileSync(`${directory}/verification.json`)), evidenceDirectory: app });
}
writeFileSync("release-artifacts/native-replacement/verification.json", JSON.stringify({ schemaVersion: 2, images: replacements }, null, 2));
script("verify-binary-source-evidence", `${root}/source-lock.json`, "release-artifacts/binary-licenses", "release-artifacts/native-replacement/verification.json");
script("package-binary-source-evidence", `${root}/source-lock.json`);
for (const image of [api, web]) script("verify-runtime-layers", image, platform);
run("grype", ["db", "update"]);
script("inspect-release-images", `--platform=${platform}`, api, web);
script("verify-ce-image-deployment", api, web, platform);
script("package-ce-binary-candidate", version, api, web, platform);
