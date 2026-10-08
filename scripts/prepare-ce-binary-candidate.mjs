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
for (const [app, image] of [["api", api], ["web", web]]) {
  run("docker", ["buildx", "build", "--platform", platform, "--load", "--build-arg", `TW_BUILD_COMMIT=${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`, "--file", `apps/${app}/Dockerfile`, "--tag", image, "."]);
}
script("collect-image-license-evidence", `--platform=${platform}`, api, web);
const root = "release-artifacts/binary-sources";
script("prepare-binary-sources", "release-artifacts/binary-licenses");
script("assemble-binary-sources", `${root}/source-plan.json`, "--acquire");
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
script("extract-binary-licenses", `${root}/verified-source-lock.json`);
script("assemble-runtime-notices", `${root}/verified-source-lock.json`);
assert.ok(readFileSync(`${root}/runtime-source-NOTICES.txt`).equals(readFileSync("THIRD_PARTY_LICENSES/runtime-source-NOTICES.txt")), "Acquired source notices differ from the reviewed notices delivered in the images");
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
