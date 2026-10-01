import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageArchiveConfig } from "./ce-image-archive.mjs";
import { RELEASE_PLATFORMS, platformArchitecture } from "./release-platforms.mjs";
import { inspectLocalImage } from "./image-inspection-lib.mjs";
import { verifyOciIndex } from "./oci-index.mjs";

const [version, inputRepository] = process.argv.slice(2);
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const repository = inputRepository?.toLowerCase();
assert.match(repository ?? "", /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/);
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const read = path => JSON.parse(readFileSync(path, "utf8"));
const output = "release-artifacts/bundle";
const provenance = read(`${output}/source-provenance.json`);
const set = read(`${output}/ce-candidate-set.json`);
assert.equal(set.version, version);
assert.equal(set.commit, run("git", ["rev-parse", "HEAD"]).trim());
const tags = ["api", "web"].flatMap(app => [version, ...RELEASE_PLATFORMS.map(platform => `${version}-${platformArchitecture(platform)}`)].map(tag => `ghcr.io/${repository}-${app}:${tag}`));
// Preflight every immutable name before the first registry write. Authentication
// or network failures are not evidence that a tag is available.
for (const image of tags) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", image], { encoding: "utf8" });
  if (result.status === 0) throw new Error(`Immutable image tag already exists: ${image}`);
  assert.match(result.stderr, /not found|manifest unknown|404/i, "Cannot establish registry tag availability");
}
for (const app of ["api", "web"]) {
  const image = `ghcr.io/${repository}-${app}:${version}`;
  const expected = {};
  const platforms = {};
  for (const platform of RELEASE_PLATFORMS) {
    const arch = platformArchitecture(platform);
    const candidate = read(`${output}/ce-candidate-${arch}.json`);
    assert.equal(candidate.platform, platform);
    assert.equal(candidate.commit, set.commit);
    assert.equal(candidate.version, version);
    const entry = candidate.images.find(entry => entry.app === app);
    assert.ok(entry && entry.platform === platform);
    const local = `task-weaver-${app}:release-${arch}`;
    const details = inspectLocalImage(local, platform);
    if (![entry.imageId, entry.configDigest].includes(details.Id)) {
      const temporary = mkdtempSync(join(tmpdir(), "ce-publication-image-"));
      try {
        const archive = join(temporary, "image.tar");
        run("docker", ["save", "--output", archive, local]);
        assert.equal(imageArchiveConfig(archive, local, platform), entry.configDigest,
          "Local publication image changed after verification");
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    const tag = `${image}-${arch}`;
    run("docker", ["tag", local, tag]);
    run("docker", ["push", tag]);
    const descriptor = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"]));
    assert.match(descriptor.digest ?? descriptor.Digest, /^sha256:[a-f0-9]{64}$/);
    const digest = descriptor.digest ?? descriptor.Digest;
    const reference = `${image.split(":")[0]}@${digest}`;
    const manifest = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", reference, "--raw"]));
    assert.equal(manifest.config.digest, entry.configDigest, "Published child runtime identity differs from the reviewed candidate");
    run("cosign", ["sign", "--yes", reference]);
    run("cosign", ["attest", "--yes", "--type", "cyclonedx", "--predicate", `${output}/${app}-image.sbom-${arch}.json`, reference]);
    run("cosign", ["attest", "--yes", "--type", "custom", "--predicate", `${output}/source-provenance.json`, reference]);
    expected[platform] = digest;
    platforms[platform] = { image: tag, digest, configDigest: entry.configDigest, localImageId: details.Id };
    writeFileSync(`${output}/${app}-image-${arch}.json`, JSON.stringify({ image: tag, digest, platform, configDigest: entry.configDigest, localImageId: details.Id }, null, 2) + "\n");
    writeFileSync(`${output}/${app}-image-${arch}.digest`, reference + "\n");
  }
  run("docker", ["buildx", "imagetools", "create", "--tag", image, ...Object.values(platforms).map(entry => `${image.split(":")[0]}@${entry.digest}`)]);
  const descriptor = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"]));
  const digest = descriptor.digest ?? descriptor.Digest;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const reference = `${image.split(":")[0]}@${digest}`;
  const index = verifyOciIndex(JSON.parse(run("docker", ["buildx", "imagetools", "inspect", reference, "--raw"])), expected);
  const predicate = { version, commit: set.commit, sourceProvenance: provenance, platforms };
  writeFileSync(`${output}/${app}-multiarch-provenance.json`, JSON.stringify(predicate, null, 2) + "\n");
  writeFileSync(`${output}/${app}-image-index.json`, JSON.stringify(index, null, 2) + "\n");
  run("cosign", ["sign", "--yes", reference]);
  run("cosign", ["attest", "--yes", "--type", "custom", "--predicate", `${output}/${app}-multiarch-provenance.json`, reference]);
  writeFileSync(`${output}/${app}-image.json`, JSON.stringify({ image, digest, platforms }, null, 2) + "\n");
  writeFileSync(`${output}/${app}-image.digest`, reference + "\n");
  console.log(`Signed reviewed multi-platform index: ${reference}`);
}
