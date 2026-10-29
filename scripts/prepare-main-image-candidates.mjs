import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { RELEASE_PLATFORMS, platformArchitecture } from "./release-platforms.mjs";

const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.match(repository ?? "", /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
assert.match(runId ?? "", /^[1-9]\d*$/);
assert.match(attempt ?? "", /^[1-9]\d*$/);
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const script = (name, ...args) => run(process.execPath, [`scripts/${name}.mjs`, ...args]);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const staging = `candidate-${runId}-${attempt}`;
for (const platform of RELEASE_PLATFORMS) {
  const arch = platformArchitecture(platform);
  const images = ["api", "web"].map(app => `task-weaver-${app}:main-base-${arch}`);
  for (const [index, app] of ["api", "web"].entries()) {
    run("docker", ["buildx", "build", "--platform", platform, "--load", "--build-arg", `TW_BUILD_COMMIT=${commit}`, "--file", `apps/${app}/Dockerfile`, "--tag", images[index], "."]);
  }
  // Use the same pinned source, configuration and patch as formal candidates.
  const sources = "release-artifacts/binary-sources";
  rmSync(sources, { recursive: true, force: true });
  script("collect-image-license-evidence", `--platform=${platform}`, ...images);
  script("prepare-binary-sources", "release-artifacts/binary-licenses");
  script("assemble-binary-sources", `${sources}/source-plan.json`, "--acquire");
  script("prepare-busybox-build-sources", `${sources}/source-lock.json`);
  script("assemble-binary-sources", `${sources}/busybox-build-source-plan.json`, "--acquire");
  script("build-reviewed-busybox", `${sources}/source-lock.json`, platform);
  const patchedImages = [];
  for (const [index, app] of ["api", "web"].entries()) {
    const patched = `task-weaver-${app}:main-${arch}`;
    script("build-busybox-image", images[index], patched, platform);
    script("verify-busybox-wget", patched, platform);
    patchedImages.push(patched);
  }
  run("grype", ["db", "update"]);
  script("inspect-release-images", `--platform=${platform}`, ...patchedImages);
  for (const [index, app] of ["api", "web"].entries()) {
    const patched = patchedImages[index];
    const target = `ghcr.io/${repository}-${app}:${staging}-${arch}`;
    run("docker", ["tag", patched, target]);
    run("docker", ["push", target]);
  }
  const evidence = `release-artifacts/main-candidates/${arch}`;
  mkdirSync(evidence, { recursive: true });
  cpSync("release-artifacts/images", `${evidence}/images`, { recursive: true });
  cpSync(sources, `${evidence}/binary-sources`, { recursive: true });
  cpSync(`release-artifacts/busybox-build/${arch}`, `${evidence}/busybox-build`, { recursive: true });
  run("docker", ["image", "rm", ...images, ...patchedImages]);
  run("docker", ["buildx", "prune", "--force"]);
}
for (const app of ["api", "web"]) {
  const image = `ghcr.io/${repository}-${app}:${staging}`;
  run("docker", ["buildx", "imagetools", "create", "--tag", image, ...RELEASE_PLATFORMS.map(platform => `${image}-${platformArchitecture(platform)}`)]);
}
